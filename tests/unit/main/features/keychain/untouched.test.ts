/**
 * Without a sealed file, starting the app and its clean-ups never reach the
 * keychain: on macOS that read is what asks for the login password.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ConnectionKeys } from "../../../../../src/main/features/agent-profiles/connection-keys";
import {
  openVoiceMemoryFile,
  RememberedVoices,
} from "../../../../../src/main/features/notes/remembered-voices";
import { RemoteAccount, SavedAccountSchema } from "../../../../../src/main/features/remote/account";
import { AccountKeys, SavedKeySchema } from "../../../../../src/main/features/remote/account-keys";
import { SealedFile, type SecretBox } from "../../../../../src/main/features/remote/sealed-file";
import { VoiceNameSettingsSchema } from "../../../../../src/shared/notes/voice-names";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A keychain that counts each read or write, and fails it. */
function countingBox() {
  const calls: string[] = [];
  const box: SecretBox = {
    available: true,
    encrypt: async () => {
      calls.push("encrypt");
      throw new Error("the keychain was read");
    },
    decrypt: async () => {
      calls.push("decrypt");
      throw new Error("the keychain was read");
    },
  };
  return { box, calls };
}

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), "keychain-untouched-"));
  dirs.push(dir);
  return dir;
}

const KeysSchema = z.record(z.string(), z.object({ target: z.string(), key: z.string() }));

test("pruning the profiles' API keys reads nothing", async () => {
  const dir = userData();
  const { box, calls } = countingBox();
  const keys = new ConnectionKeys(
    new SealedFile(join(dir, "profile-api-keys.bin"), box, KeysSchema),
    true,
  );
  await keys.prune(() => new Set(["kept"]));
  expect(await keys.status("kept", "target")).toMatchObject({ present: false });
  expect(calls).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

test("pruning the remembered voices reads nothing", async () => {
  const dir = userData();
  const { box, calls } = countingBox();
  let prefs = VoiceNameSettingsSchema.parse({ consent: "allowed", expire: true });
  const voices = new RememberedVoices(
    openVoiceMemoryFile(dir, box),
    {
      read: () => prefs,
      write: (next) => {
        prefs = next;
      },
    },
    () => {},
  );
  await voices.prune();
  expect(await voices.status()).toMatchObject({ available: true, count: 0 });
  expect(calls).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

test("restoring the remote's sign-in and account key reads nothing", async () => {
  const dir = userData();
  const { box, calls } = countingBox();
  const account = new RemoteAccount({
    server: "http://localhost:8787",
    store: new SealedFile(join(dir, "remote-account.bin"), box, SavedAccountSchema),
    openExternal: async () => {},
  });
  await account.restore();
  const keys = new AccountKeys({
    account,
    store: new SealedFile(join(dir, "remote-key.bin"), box, SavedKeySchema),
  });
  await keys.restore();
  expect(account.state().status).toBe("signed-out");
  expect(keys.state().status).toBe("signed-out");
  expect(calls).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});
