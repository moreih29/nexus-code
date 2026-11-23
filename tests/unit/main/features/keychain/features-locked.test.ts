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

const apiKeyProfile = {
  id: "a",
  agent: "claude",
  name: "A",
  dir: "/tmp/a",
  connection: { method: "api-key" },
} as unknown as AgentProfile;

const within = (promise: Promise<unknown>, ms = 1000) =>
  Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);

describe("a key a chat needs, which an agent or a resumed chat may start", () => {
  test("asks again once put off, and goes on as answered", async () => {
    const { gate, calls, keys } = await setup();
    const key = keys.get("a", "t");
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.putOff();
    expect(await key).toBeUndefined();
    const later = keys.get("b", "t");
    expect(gate.status().state).toBe("ask");
    gate.putOff();
    expect(await later).toBeUndefined();
    expect(calls).toEqual([]);
    const now = keys.get("b", "t");
    expect(gate.status().state).toBe("ask");
    void gate.open();
    expect(await now).toBe("sk-bbbb2222");
    expect(gate.status().state).toBe("open");
  });

  test("refused in macOS: goes on without it, asking nothing", async () => {
    const { gate, keys } = await setup({ refuse: true });
    void gate.open();
    expect(await keys.get("a", "t")).toBeUndefined();
    expect(gate.status()).toMatchObject({ state: "locked", refused: true });
    expect(await keys.get("b", "t")).toBeUndefined();
    expect(gate.status()).toMatchObject({ state: "locked", refused: true });
  });
});

describe("what the user does opens it", () => {
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

describe("what the user does, with the app's own reads waiting", () => {
  test("saving an API key put off, with the start's cleanup waiting", async () => {
    const { gate, keys } = await setup();
    gate.putOff();
    const pruned = gate.whenOpen("profileKeys", () => keys.prune(() => new Set(["a", "b"])));
    expect(await within(keys.saveProfile(...profile("sk-new-3333")))).toBe("settled");
    expect(await within(pruned)).toBe("settled");
    expect(await keys.get("a", "t")).toBeUndefined();
    expect(await keys.get("b", "t")).toBe("sk-bbbb2222");
  });

  test("agreeing to remember voices put off, with the start's cleanup waiting", async () => {
    const { gate, voices } = await setup();
    gate.putOff();
    const pruned = gate.whenOpen("voices", () => voices.prune());
    expect(await within(voices.consent(true))).toBe("settled");
    expect(await within(pruned)).toBe("settled");
    expect(await voices.list()).toEqual([{ name: "A", count: 1, lastHeard: TIME }]);
  });

  test("a save waiting on the question, answered from another window", async () => {
    const { gate, keys } = await setup();
    const pruned = gate.whenOpen("profileKeys", () => keys.prune(() => new Set(["a", "b"])));
    const saving = keys.saveProfile(...profile("sk-new-3333"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opening = gate.open();
    expect(await within(saving)).toBe("settled");
    expect(await within(opening)).toBe("settled");
    expect(await within(pruned)).toBe("settled");
    expect(await opening).toBe(true);
    expect(await keys.get("b", "t")).toBe("sk-bbbb2222");
  });
});

describe("an API-key profile saved unchanged while locked", () => {
  test.each([
    ["put off", false],
    ["refused", true],
  ])("%s: saved without the keychain, its key kept", async (_label, refuse) => {
    const { gate, calls, keys, sealed } = await setup({ refuse });
    const before = sealed();
    if (refuse) {
      void gate.open();
      expect(await keys.get("a", "t")).toBeUndefined();
    } else gate.putOff();
    calls.length = 0;
    let committed = false;
    const saved = keys.saveProfile(
      apiKeyProfile,
      undefined,
      () => {
        committed = true;
      },
      apiKeyProfile,
    );
    expect(await saved).toBe(false);
    expect(committed).toBe(true);
    expect(calls).toEqual([]);
    expect(gate.status().state).toBe("locked");
    expect(sealed()).toEqual(before);
  });

  test("turned into an API-key profile, it still needs the keychain", async () => {
    const { gate, keys } = await setup({ refuse: true });
    void gate.open();
    expect(await keys.get("a", "t")).toBeUndefined();
    await expect(
      keys.saveProfile(apiKeyProfile, undefined, () => {}, {
        ...apiKeyProfile,
        connection: { method: "account" },
      } as AgentProfile),
    ).rejects.toThrow("The keychain is locked");
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
