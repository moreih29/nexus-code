/** The account key, locked with the account password and opened again. */
import { describe, expect, test } from "bun:test";
import { hkdfSync } from "node:crypto";
import {
  KeyBundleSchema,
  MAX_OPEN_KDF,
  ROOM_KEY_INFO,
} from "../../../../../packages/remote-protocol/src";
import {
  KdfTooHeavyError,
  lockAccountKey,
  newAccountKey,
  passwordLongEnough,
  roomKeyOf,
  unlockAccountKey,
  WrongPasswordError,
} from "../../../../../src/main/features/remote/account-key";

// Argon2id's floor, so the tests run fast; the app locks with DEFAULT_KDF.
const kdf = { ops: 1, mem: 16 * 1024 * 1024 };

describe("the account key", () => {
  test("locks into a bundle the server takes, which the password opens", async () => {
    const key = await newAccountKey();
    const bundle = await lockAccountKey({
      key,
      kid: 1,
      password: "correct horse battery",
      userId: "u1",
      kdf,
    });
    expect(KeyBundleSchema.parse(bundle)).toEqual(bundle);
    expect(JSON.stringify(bundle).length).toBeLessThan(1024);
    expect(await unlockAccountKey(bundle, "correct horse battery", "u1")).toEqual(key);
  });

  test("does not open with another password, for another user, or as another version", async () => {
    const key = await newAccountKey();
    const bundle = await lockAccountKey({
      key,
      kid: 2,
      password: "correct horse battery",
      userId: "u1",
      kdf,
    });
    await expect(unlockAccountKey(bundle, "correct horse batterY", "u1")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    await expect(unlockAccountKey(bundle, "correct horse battery", "u2")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    await expect(
      unlockAccountKey({ ...bundle, kid: 1 }, "correct horse battery", "u1"),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  test("is not opened past MAX_OPEN_KDF, which would hold up the app, and Argon2id is not run", async () => {
    const bundle = await lockAccountKey({
      key: await newAccountKey(),
      kid: 1,
      password: "correct horse battery",
      userId: "u1",
      kdf,
    });
    for (const heavier of [
      { ...bundle.kdf, ops: MAX_OPEN_KDF.ops + 1 },
      { ...bundle.kdf, mem: MAX_OPEN_KDF.mem + 1024 * 1024 },
      { ...bundle.kdf, ops: 10, mem: 1024 * 1024 * 1024 },
    ]) {
      const started = performance.now();
      await expect(
        unlockAccountKey({ ...bundle, kdf: heavier }, "correct horse battery", "u1"),
      ).rejects.toBeInstanceOf(KdfTooHeavyError);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  test("takes a password typed in another normalization form", async () => {
    const key = await newAccountKey();
    // "한글" typed as composed syllables, then as their decomposed jamo.
    const composed = "비밀번호는한글로열두자요";
    const bundle = await lockAccountKey({ key, kid: 1, password: composed, userId: "u1", kdf });
    expect(await unlockAccountKey(bundle, composed.normalize("NFD"), "u1")).toEqual(key);
  });

  test("a new lock of the same key differs, salt and all", async () => {
    const key = await newAccountKey();
    const a = await lockAccountKey({
      key,
      kid: 1,
      password: "correct horse battery",
      userId: "u1",
      kdf,
    });
    const b = await lockAccountKey({
      key,
      kid: 1,
      password: "correct horse battery",
      userId: "u1",
      kdf,
    });
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.box).not.toBe(b.box);
  });

  test("the room key is HKDF-SHA256 of it, with the protocol's info", async () => {
    const key = await newAccountKey();
    const expected = new Uint8Array(hkdfSync("sha256", key, new Uint8Array(0), ROOM_KEY_INFO, 32));
    expect(roomKeyOf(key)).toEqual(expected);
    expect(roomKeyOf(key)).not.toEqual(key);
  });

  test("a password is long enough at 12 characters, as the user counts them", () => {
    expect(passwordLongEnough("a".repeat(11))).toBe(false);
    expect(passwordLongEnough("a".repeat(12))).toBe(true);
    expect(passwordLongEnough("한".repeat(12).normalize("NFD"))).toBe(true);
    expect(passwordLongEnough("🔑".repeat(12))).toBe(true);
  });
});
