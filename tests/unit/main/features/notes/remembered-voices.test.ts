import { afterEach, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openVoiceMemoryFile,
  RememberedVoices,
  registerRememberedVoices,
} from "../../../../../src/main/features/notes/remembered-voices";
import type { SecretBox } from "../../../../../src/main/features/remote/sealed-file";
import {
  VOICE_NAME_RETENTION_MS,
  type VoiceNameSettings,
  VoiceNameSettingsSchema,
} from "../../../../../src/shared/notes/voice-names";
import { type AppState, AppStateSchema } from "../../../../../src/shared/types/app-state";

import { createIpcPair, resetInMemoryIpc, setupInMemoryRouter } from "../../../../helpers/ipc-pair";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TIME = 1_900_000_000_000;
const vector = (axis = 0) => Array.from({ length: 192 }, (_, i) => (i === axis ? 1 : 0));

function setup(available = true) {
  const dir = mkdtempSync(join(tmpdir(), "remembered-voices-"));
  dirs.push(dir);
  const key = randomBytes(32);
  const box: SecretBox = {
    available,
    encrypt: async (text) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt: async (bytes) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
  };
  let preferences = VoiceNameSettingsSchema.parse({});
  let now = TIME;
  const open = () =>
    new RememberedVoices(
      openVoiceMemoryFile(dir, box),
      {
        read: () => preferences,
        write: (next) => {
          preferences = next;
        },
      },
      () => {},
      () => now,
    );
  return {
    dir,
    box,
    open,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const sample = (name: string, revision: number, axis = 0) => ({
  name,
  revision,
  recordingId: "r0000000000",
  recordedAt: TIME,
  vector: vector(axis),
});

test("only learns after consent and reopens an encrypted profile without exposing vectors", async () => {
  const { dir, open } = setup();
  const store = open();
  expect(await store.learn(sample("Synthetic Voice", 0))).toBe(false);
  const { revision } = await store.consent(true);
  expect(await store.learn(sample("Synthetic Voice", revision))).toBe(true);
  const [file] = readdirSync(dir);
  expect(file).toBe("remembered-voices.bin");
  const sealed = readFileSync(join(dir, file as string));
  expect(sealed.includes(Buffer.from("Synthetic Voice"))).toBe(false);
  const restored = open();
  expect(await restored.list()).toEqual([{ name: "Synthetic Voice", count: 1, lastHeard: TIME }]);
  expect(
    await restored.match({
      revision: 0,
      named: [],
      speakers: [{ key: "1", rejected: [], vector: vector() }],
    }),
  ).toEqual([{ key: "1", name: "Synthetic Voice" }]);
});

test("keeps memory unavailable without encryption and writes no file", async () => {
  const { dir, open } = setup(false);
  const store = open();
  const status = await store.consent(true);
  expect(status.available).toBe(false);
  expect(await store.learn(sample("A", status.revision))).toBe(false);
  expect(await store.list()).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

test("decline persists and the suggestion setting can enable memory", async () => {
  const { open } = setup();
  expect(await open().consent(false)).toMatchObject({ suggest: false, consent: "declined" });
  const store = open();
  expect(await store.consent(true)).toMatchObject({ suggest: false, consent: "declined" });
  expect(await store.configure({ suggest: true })).toMatchObject({
    suggest: true,
    consent: "allowed",
  });
});

test("removes one or all and rejects enrollment started before deletion", async () => {
  const { dir, open } = setup();
  const store = open();
  const { revision } = await store.consent(true);
  await Promise.all([store.learn(sample("A", revision)), store.learn(sample("B", revision, 1))]);
  await store.remove("A");
  expect(await store.learn(sample("A", revision))).toBe(false);
  expect(await open().list()).toEqual([{ name: "B", count: 1, lastHeard: TIME }]);
  await store.clear();
  expect(await open().list()).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

test.each([
  ["enabled", true, 0],
  ["disabled", false, 1],
] as const)("retention %s", async (_label, expire, count) => {
  const { open, advance } = setup();
  const store = open();
  await store.consent(true);
  const { revision } = await store.configure({ expire });
  await store.learn(sample("A", revision));
  advance(VOICE_NAME_RETENTION_MS);
  const restored = open();
  await restored.prune();
  expect(await restored.list()).toHaveLength(count);
  if (!expire) {
    await restored.configure({ expire: true });
    expect(await restored.list()).toEqual([]);
  }
});

test("app settings serialize only consent and preferences", () => {
  const settings: VoiceNameSettings = { consent: "allowed", suggest: true, expire: false };
  const state = AppStateSchema.parse({
    rememberedVoices: { ...settings, people: [sample("A", 0)] },
  });
  expect(state.rememberedVoices).toEqual(settings);
});

test.each([
  ["choice shared", false],
  ["closed window hands off the prompt", true],
] as const)("first consent in multiple windows: %s", async (_label, closes) => {
  const { dir, box } = setup();
  let state = AppStateSchema.parse({});
  await setupInMemoryRouter();
  const feature = registerRememberedVoices(
    dir,
    {
      getState: () => state,
      setState: (next: Partial<AppState>) => {
        state = { ...state, ...next };
      },
    },
    async () => box,
  );
  try {
    const first = createIpcPair();
    const second = createIpcPair();
    const claim = "claimConsent";
    expect(await first.window.ipc.call("voiceMemory", claim, undefined)).toMatchObject({
      ok: true,
      value: { prompt: true, status: { consent: "pending" } },
    });
    const waiting = second.window.ipc.call("voiceMemory", claim, undefined);
    if (closes) first.sender.destroy();
    else {
      expect(
        await first.window.ipc.call("voiceMemory", "consent", { allowed: false }),
      ).toMatchObject({
        ok: true,
        value: { consent: "declined" },
      });
    }
    expect(await waiting).toMatchObject({
      ok: true,
      value: { prompt: closes, status: { consent: closes ? "pending" : "declined" } },
    });
  } finally {
    feature.dispose();
    resetInMemoryIpc();
    await feature.waitForWrites();
  }
});
