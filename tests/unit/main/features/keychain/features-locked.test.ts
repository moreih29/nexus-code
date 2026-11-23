/**
 * The profiles' API keys and the remembered voices while the keychain is
 * not open: what the app reads by itself waits, what the user does opens
 * it, and a refusal leaves the sealed files as they are.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ConnectionKeys } from "../../../../../src/main/features/agent-profiles/connection-keys";
import { KeychainGate } from "../../../../../src/main/features/keychain/gate";
import {
  openVoiceMemoryFile,
  RememberedVoices,
} from "../../../../../src/main/features/notes/remembered-voices";
import { SealedFile } from "../../../../../src/main/features/remote/sealed-file";
import type { AgentProfile } from "../../../../../src/shared/agent-profiles/profiles";
import { VoiceNameSettingsSchema } from "../../../../../src/shared/notes/voice-names";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KeysSchema = z.record(z.string(), z.object({ target: z.string(), key: z.string() }));
const TIME = 1_900_000_000_000;

/** A folder with sealed files written while the keychain was open, and a new run's gate over it. */
async function setup(options: { refuse?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keychain-features-"));
  dirs.push(dir);
  let refuse = false;
  const calls: string[] = [];
  const raw = {
    encrypt: async (text: string) => {
      calls.push("encrypt");
      if (refuse) throw new Error("Error while encrypting the text");
      return Buffer.from(text).reverse();
    },
    decrypt: async (data: Buffer) => {
      calls.push("decrypt");
      if (refuse) throw new Error("safeStorage.decryptStringAsync is temporarily unavailable.");
      return Buffer.from(data).reverse().toString();
    },
  };
  const newGate = (signature: string) =>
    new KeychainGate({
      raw,
      items: () => ["profileKeys", "voices"],
      signature: async () => signature,
      recorded: { get: () => "before", set: () => {} },
      onChange: () => {},
    });
  // The last run, signed as recorded: open.
  const before = newGate("before");
  await before.decided();
  const keysFile = join(dir, "profile-api-keys.bin");
  await new SealedFile(keysFile, before.box, KeysSchema).save({
    a: { target: "t", key: "sk-aaaa1111" },
    b: { target: "t", key: "sk-bbbb2222" },
  });
  let prefs = VoiceNameSettingsSchema.parse({ consent: "allowed" });
  const preferences = {
    read: () => prefs,
    write: (next: typeof prefs) => {
      prefs = next;
    },
  };
  const firstVoices = new RememberedVoices(
    openVoiceMemoryFile(dir, before.box),
    preferences,
    () => {},
    () => TIME,
    before,
  );
  await firstVoices.learn({
    name: "A",
    revision: 0,
    recordingId: "r0000000000",
    recordedAt: TIME,
    vector: Array.from({ length: 192 }, (_, i) => (i === 0 ? 1 : 0)),
  });
  const voicesFile = join(dir, "remembered-voices.bin");
  expect(existsSync(voicesFile)).toBe(true);
  // This run: signed otherwise, so it asks.
  const gate = newGate("after");
  await gate.decided();
  calls.length = 0;
  refuse = options.refuse ?? false;
  const keys = new ConnectionKeys(new SealedFile(keysFile, gate.box, KeysSchema), true, gate);
  const voices = new RememberedVoices(
    openVoiceMemoryFile(dir, gate.box),
    preferences,
    () => {},
    () => TIME,
    gate,
  );
  return {
    gate,
    calls,
    keys,
    voices,
    sealed: () => [readFileSync(keysFile), readFileSync(voicesFile)],
  };
}

const profile = (key?: string | null): Parameters<ConnectionKeys["saveProfile"]> => [
  {
    id: "a",
    agent: "claude",
    name: "A",
    dir: "/tmp/a",
    connection: { method: "custom", baseUrl: "https://example.com", models: [] },
  } as unknown as AgentProfile,
  key,
  () => {},
];

describe("what the app reads by itself waits", () => {
  test("the settings' views read nothing and show nothing kept", async () => {
    const { gate, calls, keys, voices } = await setup();
    expect(gate.status().state).toBe("ask");
    expect(await keys.status("a", "t")).toEqual({
      present: false,
      last4: undefined,
      persistent: true,
    });
    expect(await voices.status()).toMatchObject({ available: true, count: 0 });
    expect(await voices.list()).toEqual([]);
    expect(
      await voices.match({
        revision: 0,
        named: [],
        speakers: [{ key: "1", rejected: [], vector: Array(192).fill(0) }],
      }),
    ).toEqual([]);
    // A profile saved without a key leaves the keys unread.
    expect(await keys.saveProfile(...profile(undefined))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("once opened, they read what was kept", async () => {
    const { gate, keys, voices } = await setup();
    await gate.open();
    expect(await keys.status("a", "t")).toMatchObject({ present: true, last4: "1111" });
    expect(await voices.list()).toEqual([{ name: "A", count: 1, lastHeard: TIME }]);
  });
});

describe("what the user does opens it", () => {
  test("a key used for a chat, after the user's answer", async () => {
    const { gate, keys } = await setup();
    const key = keys.get("a", "t");
    // Asked while the question is up: waits for its answer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.putOff();
    expect(await key).toBeUndefined();
    // Locked for the run: the next use opens it.
    expect(await keys.get("b", "t")).toBe("sk-bbbb2222");
    expect(gate.status().state).toBe("open");
  });

  test("saving an API key keeps the other profiles' keys", async () => {
    const { gate, keys } = await setup();
    gate.putOff();
    expect(await keys.saveProfile(...profile("sk-new-3333"))).toBe(true);
    expect(gate.isOpen()).toBe(true);
    expect(await keys.get("a", "t")).toBeUndefined();
    expect(await keys.get("b", "t")).toBe("sk-bbbb2222");
  });

  test("remembering a voice, and agreeing to it", async () => {
    const { gate, voices } = await setup();
    gate.putOff();
    await voices.consent(true);
    expect(gate.isOpen()).toBe(true);
    expect(await voices.list()).toEqual([{ name: "A", count: 1, lastHeard: TIME }]);
  });
});

describe("refused in macOS's prompt", () => {
  test("is locked, not none: nothing is written over, nothing taken for signed out", async () => {
    const { gate, keys, voices, sealed } = await setup({ refuse: true });
    const before = sealed();
    gate.putOff();
    await expect(keys.saveProfile(...profile("sk-new-3333"))).rejects.toThrow(
      "The keychain is locked",
    );
    expect(gate.status().state).toBe("locked");
    expect(await keys.get("b", "t")).toBeUndefined();
    expect(
      await voices.learn({
        name: "B",
        revision: 0,
        recordingId: "r0000000001",
        recordedAt: TIME,
        vector: Array.from({ length: 192 }, (_, i) => (i === 1 ? 1 : 0)),
      }),
    ).toBe(false);
    await expect(voices.prune()).resolves.toBeUndefined();
    expect(sealed()).toEqual(before);
  });
});
