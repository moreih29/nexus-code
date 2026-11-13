/** Where the sign-in and the account key are kept: sealed on disk, or only in memory where nothing seals. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedAccountSchema } from "../../../../../src/main/features/remote/account";
import { SealedFile, type SecretBox } from "../../../../../src/main/features/remote/sealed-file";

const account = {
  server: "http://localhost:8787",
  token: "tok",
  user: { id: "u1", email: "me@example.com", name: "Me" },
  device: { id: "d1", name: "Mac", platform: "darwin" },
};

/** Seals by reversing the bytes: enough to tell sealed from plain. */
function box(available: boolean): SecretBox {
  return {
    available,
    encrypt: async (text) => Buffer.from(text).reverse(),
    decrypt: async (data) => Buffer.from(data).reverse().toString(),
  };
}

const dirs: string[] = [];
function fileIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "remote-account-"));
  dirs.push(dir);
  return join(dir, "sub", "remote-account.bin");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SealedFile", () => {
  test("seals the sign-in on disk, owner-only, and reads it back", async () => {
    const file = fileIn();
    await new SealedFile(file, box(true), SavedAccountSchema).save(account);
    expect(readFileSync(file).toString()).not.toContain("tok");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await new SealedFile(file, box(true), SavedAccountSchema).load()).toEqual(account);
  });

  test("where nothing seals, keeps it in memory only", async () => {
    const file = fileIn();
    const store = new SealedFile(file, box(false), SavedAccountSchema);
    await store.save(account);
    expect(existsSync(file)).toBe(false);
    expect(await store.load()).toEqual(account);
    expect(await new SealedFile(file, box(false), SavedAccountSchema).load()).toBeNull();
  });

  test("a damaged file is as good as signed out, and clear removes it", async () => {
    const file = fileIn();
    const store = new SealedFile(file, box(true), SavedAccountSchema);
    await store.save(account);
    writeFileSync(file, "garbage");
    expect(await store.load()).toBeNull();
    store.clear();
    expect(existsSync(file)).toBe(false);
  });
});
