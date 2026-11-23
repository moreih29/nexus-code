import { join } from "node:path";
import { z } from "zod";
import {
  type ConnectionKeyStatus,
  connectionKeyTarget,
} from "../../../shared/agent-profiles/connection";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import { SEALED_FILES } from "../keychain/files";
import type { Keychain } from "../keychain/gate";
import { type Kept, KeychainLockedError, keptInMemory, SealedFile } from "../remote/sealed-file";

const KeysSchema = z.record(z.string(), z.object({ target: z.string(), key: z.string() }));
type Keys = z.infer<typeof KeysSchema>;

type KeysKeychain = Pick<Keychain, "isOpen" | "has" | "unlock" | "request">;
const ALWAYS_OPEN: KeysKeychain = {
  isOpen: () => true,
  has: () => false,
  unlock: async () => true,
  request: async () => true,
};

export class ConnectionKeys {
  private pending = Promise.resolve();

  constructor(
    private readonly storage: Kept<Keys>,
    private readonly persistent: boolean,
    private readonly keychain: KeysKeychain = ALWAYS_OPEN,
  ) {}

  async get(id: string, target: string | undefined): Promise<string | undefined> {
    if (!this.keychain.isOpen()) {
      if (!this.keychain.has("profileKeys") || !(await this.keychain.request())) return undefined;
    }
    await this.pending;
    return this.read(id, target).catch((error: unknown) => {
      if (error instanceof KeychainLockedError) return undefined;
      throw error;
    });
  }

  async status(id?: string, target?: string): Promise<ConnectionKeyStatus> {
    await this.pending;
    const key =
      id && target && this.keychain.isOpen()
        ? await this.read(id, target).catch(() => undefined)
        : undefined;
    return {
      present: key !== undefined,
      last4: key && key.length > 4 ? key.slice(-4) : undefined,
      persistent: this.persistent,
    };
  }

  private async read(id: string, target: string | undefined): Promise<string | undefined> {
    const saved = (await this.storage.load())?.[id];
    return saved?.target === target ? saved?.key : undefined;
  }

  async saveProfile(
    profile: AgentProfile,
    key: string | null | undefined,
    commit: () => void,
    existing?: AgentProfile | null,
  ): Promise<boolean> {
    const target = connectionKeyTarget(profile.agent, profile.connection);
    const keptApiKey =
      key === undefined &&
      !this.keychain.isOpen() &&
      this.keychain.has("profileKeys") &&
      existing?.agent === profile.agent &&
      existing.connection?.method === "api-key" &&
      connectionKeyTarget(existing.agent, existing.connection) === target;
    if ((key === undefined && profile.connection?.method !== "api-key") || keptApiKey) {
      return this.serialize(async () => {
        commit();
        return false;
      });
    }
    if (!(await this.keychain.unlock())) throw new KeychainLockedError();
    return this.serialize(async () => {
      const before = (await this.storage.load()) ?? {};
      const saved = before[profile.id];
      const nextKey = key === undefined && saved?.target === target ? saved?.key : key;
      const after = { ...before };
      if (target && nextKey) after[profile.id] = { target, key: nextKey };
      else if (key === null && saved?.target === target) delete after[profile.id];
      if (profile.connection?.method === "api-key" && !nextKey && key !== null) {
        throw new Error("An API key is required for this connection");
      }
      const changed =
        saved?.target !== after[profile.id]?.target || saved?.key !== after[profile.id]?.key;
      if (changed) await this.storage.save(after);
      try {
        commit();
      } catch (error) {
        if (changed) await this.storage.save(before);
        throw error;
      }
      return changed;
    });
  }

  prune(getIds: () => ReadonlySet<string>): Promise<void> {
    return this.serialize(async () => {
      const keys = await this.storage.load();
      if (!keys) return;
      const ids = getIds();
      const kept = Object.entries(keys).filter(([id]) => ids.has(id));
      if (kept.length !== Object.keys(keys).length)
        await this.storage.save(Object.fromEntries(kept));
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    this.pending = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

export async function openConnectionKeys(keychain: Keychain): Promise<ConnectionKeys> {
  const { app } = await import("electron");
  const { box } = keychain;
  if (!box) return new ConnectionKeys(keptInMemory(), false);
  return new ConnectionKeys(
    new SealedFile(join(app.getPath("userData"), SEALED_FILES.profileKeys), box, KeysSchema),
    box.available,
    keychain,
  );
}
