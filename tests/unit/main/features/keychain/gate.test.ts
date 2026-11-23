/**
 * The keychain gate: asks before reading when the app's signature changed,
 * keeps the sealed files locked when put off or refused, and says when
 * macOS is asking.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  KEYCHAIN_SLOW_MS,
  KeychainGate,
  type KeychainGateDeps,
  refusedByKeychain,
} from "../../../../../src/main/features/keychain/gate";
import {
  KeychainLockedError,
  SealedFile,
} from "../../../../../src/main/features/remote/sealed-file";
import type { KeychainItem, KeychainStatus } from "../../../../../src/shared/keychain";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEMPORARILY = "safeStorage.decryptStringAsync is temporarily unavailable. Please try again.";
const ENCRYPT_FAILED =
  "Error while encrypting the text provided to safeStorage.encryptStringAsync.";
const DECRYPT_FAILED =
  "Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.";

/**
 * Electron's safeStorage on a Mac, as far as the gate sees it: "v10" and the
 * text reversed, or what macOS's prompt answered (refused: every call fails as
 * Chromium's encryptor without a key does).
 */
function fakeSafeStorage(options: { refuse?: boolean; delayMs?: number } = {}) {
  const calls: string[] = [];
  const wait = () => new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
  const raw: KeychainGateDeps["raw"] = {
    encrypt: async (text) => {
      calls.push("encrypt");
      await wait();
      if (options.refuse) throw new Error(ENCRYPT_FAILED);
      return Buffer.concat([Buffer.from("v10"), Buffer.from(text).reverse()]);
    },
    decrypt: async (data) => {
      calls.push("decrypt");
      await wait();
      if (options.refuse) throw new Error(TEMPORARILY);
      if (data.subarray(0, 3).toString() !== "v10") throw new Error(DECRYPT_FAILED);
      return Buffer.from(data.subarray(3)).reverse().toString();
    },
  };
  return { raw, calls };
}

function gateWith(
  options: {
    items?: KeychainItem[];
    signature?: string | null;
    recorded?: string | null;
    refuse?: boolean;
    delayMs?: number;
    slowMs?: number;
  } = {},
) {
  const storage = fakeSafeStorage(options);
  const statuses: KeychainStatus[] = [];
  let recorded = options.recorded ?? null;
  let signatureAsked = 0;
  const deps: KeychainGateDeps = {
    raw: storage.raw,
    items: () => options.items ?? [],
    signature: async () => {
      signatureAsked++;
      return options.signature === undefined ? "signed-now" : options.signature;
    },
    recorded: {
      get: () => recorded,
      set: (signature) => {
        recorded = signature;
      },
    },
    onChange: (status) => statuses.push(status),
    ...(options.slowMs !== undefined ? { slowMs: options.slowMs } : {}),
  };
  const gate = new KeychainGate(deps);
  return {
    gate,
    calls: storage.calls,
    statuses,
    recorded: () => recorded,
    signatureAsked: () => signatureAsked,
  };
}

function sealedFileIn(gate: KeychainGate) {
  const dir = mkdtempSync(join(tmpdir(), "keychain-gate-"));
  dirs.push(dir);
  return new SealedFile(join(dir, "remote-account.bin"), gate.box, z.object({ token: z.string() }));
}

describe("whether the user is asked before the keychain is read", () => {
  test("without sealed files it opens at once, looking up no signature", async () => {
    const { gate, signatureAsked } = gateWith({ items: [] });
    await gate.decided();
    expect(gate.isOpen()).toBe(true);
    expect(signatureAsked()).toBe(0);
  });

  test("signed as when it last opened: open, nothing asked", async () => {
    const { gate } = gateWith({ items: ["remote"], signature: "same", recorded: "same" });
    await gate.decided();
    expect(gate.isOpen()).toBe(true);
    expect(gate.status().state).not.toBe("ask");
  });

  test.each([
    ["signed otherwise", "new", "old"],
    ["never opened before", "new", null],
    ["the signature cannot be told", null, "old"],
  ] as const)("%s: asks first, reading nothing", async (_label, signature, recorded) => {
    const { gate, calls } = gateWith({ items: ["profileKeys", "voices"], signature, recorded });
    let ran = false;
    void gate.whenOpen("prune", async () => {
      ran = true;
    });
    await gate.decided();
    expect(gate.status()).toEqual({
      state: "ask",
      items: ["profileKeys", "voices"],
      busy: false,
    });
    expect(gate.isOpen()).toBe(false);
    expect(ran).toBe(false);
    // The box is the net: nothing slips through to safeStorage meanwhile.
    await expect(gate.box.decrypt(Buffer.from("v10x"))).rejects.toBeInstanceOf(KeychainLockedError);
    expect(calls).toEqual([]);
  });
});

describe("the user's answer", () => {
  test("continue runs the reads that waited, then it is open", async () => {
    const { gate } = gateWith({ items: ["remote"], recorded: "old" });
    const order: string[] = [];
    const restored = gate.whenOpen("remote", async () => {
      order.push("restore");
    });
    await gate.decided();
    expect(await gate.open()).toBe(true);
    await restored;
    expect(order).toEqual(["restore"]);
    expect(gate.status().state).toBe("open");
  });

  test("later keeps it locked; a background read waits, the next one replacing it", async () => {
    const { gate, calls } = gateWith({ items: ["voices"], recorded: "old" });
    await gate.decided();
    gate.putOff();
    expect(gate.status().state).toBe("locked");
    const ran: string[] = [];
    const first = gate.whenOpen("voices", async () => {
      ran.push("first");
    });
    const second = gate.whenOpen("voices", async () => {
      ran.push("second");
    });
    await Promise.resolve();
    expect(ran).toEqual([]);
    // The settings' button opens it.
    expect(await gate.open()).toBe(true);
    await Promise.all([first, second]);
    expect(ran).toEqual(["second"]);
    expect(calls).toEqual([]);
  });

  test("what the user does waits for the answer, and opens a locked keychain", async () => {
    const { gate } = gateWith({ items: ["remote"], recorded: "old" });
    await gate.decided();
    const waiting = gate.unlock();
    gate.putOff();
    expect(await waiting).toBe(false);
    let restored = false;
    void gate.whenOpen("remote", async () => {
      restored = true;
    });
    expect(await gate.unlock()).toBe(true);
    expect(restored).toBe(true);
    expect(gate.status().state).toBe("open");
  });

  test("opening from the question leaves it at once, so no other window takes it", async () => {
    const { gate } = gateWith({ items: ["remote"], recorded: "old" });
    await gate.decided();
    void gate.open();
    expect(gate.status().state).toBe("opening");
  });
});

describe("the signature it opened for", () => {
  test("is noted after the first read that worked, once", async () => {
    const { gate, recorded, signatureAsked } = gateWith({
      items: ["remote"],
      signature: "new",
      recorded: "old",
    });
    await gate.decided();
    await gate.open();
    expect(recorded()).toBe("old");
    const file = sealedFileIn(gate);
    await file.save({ token: "t" });
    expect(await file.load()).toEqual({ token: "t" });
    await Promise.resolve();
    expect(recorded()).toBe("new");
    expect(signatureAsked()).toBe(1);
  });

  test("is looked up only once something is sealed, when nothing was at the start", async () => {
    const { gate, recorded, signatureAsked } = gateWith({ items: [], signature: "first" });
    await gate.decided();
    expect(signatureAsked()).toBe(0);
    await sealedFileIn(gate).save({ token: "t" });
    await Promise.resolve();
    expect(signatureAsked()).toBe(1);
    expect(recorded()).toBe("first");
  });

  test("is not noted where it cannot be told, so the next run asks again", async () => {
    const { gate, recorded } = gateWith({ items: [], signature: null });
    await gate.decided();
    await sealedFileIn(gate).save({ token: "t" });
    await Promise.resolve();
    expect(recorded()).toBeNull();
  });
});

describe("while macOS asks", () => {
  test(`a call past ${KEYCHAIN_SLOW_MS}ms is busy until it ends`, async () => {
    expect(KEYCHAIN_SLOW_MS).toBe(500);
    const { gate, statuses } = gateWith({ items: [], delayMs: 60, slowMs: 20 });
    await gate.decided();
    statuses.length = 0;
    await sealedFileIn(gate).save({ token: "t" });
    expect(statuses.map((s) => s.busy)).toEqual([true, false]);
    expect(gate.status().busy).toBe(false);
  });

  test("a quick call says nothing", async () => {
    const { gate, statuses } = gateWith({ items: [], delayMs: 0, slowMs: 50 });
    await gate.decided();
    statuses.length = 0;
    await sealedFileIn(gate).save({ token: "t" });
    expect(statuses).toEqual([]);
  });
});

describe("refused in macOS's prompt", () => {
  test("Chromium's failures: refused, or the data", () => {
    expect(refusedByKeychain("decrypt", new Error(TEMPORARILY))).toBe(true);
    expect(refusedByKeychain("encrypt", new Error(ENCRYPT_FAILED))).toBe(true);
    expect(refusedByKeychain("decrypt", new Error(DECRYPT_FAILED))).toBe(false);
  });

  test("locks it; the file is neither taken for none nor written over", async () => {
    const { gate } = gateWith({ items: ["remote"], recorded: "old", refuse: true });
    const file = sealedFileIn(gate);
    const path = (file as unknown as { file: string }).file;
    writeFileSync(path, "v10sealed");
    let tries = 0;
    const restored = gate.whenOpen("remote", async () => {
      tries++;
      await file.load();
    });
    await gate.decided();
    expect(await gate.open()).toBe(false);
    await restored;
    expect(gate.status().state).toBe("locked");
    await expect(file.load()).rejects.toBeInstanceOf(KeychainLockedError);
    await expect(file.save({ token: "new" })).rejects.toBeInstanceOf(KeychainLockedError);
    expect(readFileSync(path, "utf8")).toBe("v10sealed");
    // The read waits for the next opening.
    await gate.open();
    expect(tries).toBe(2);
  });

  test("a damaged file is still as good as none, the keychain open", async () => {
    const { gate } = gateWith({ items: ["remote"], signature: "s", recorded: "s" });
    await gate.decided();
    const file = sealedFileIn(gate);
    writeFileSync((file as unknown as { file: string }).file, "garbage");
    expect(await file.load()).toBeNull();
    expect(gate.status().state).toBe("open");
  });
});
