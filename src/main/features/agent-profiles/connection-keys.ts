import { join } from "node:path";
import { z } from "zod";
import {
  type ConnectionKeyStatus,
  connectionKeyTarget,
} from "../../../shared/agent-profiles/connection";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import { electronSecretBox, type Kept, keptInMemory, SealedFile } from "../remote/sealed-file";

const KeysSchema = z.record(z.string(), z.object({ target: z.string(), key: z.string() }));
type Keys = z.infer<typeof KeysSchema>;

export class ConnectionKeys {
  private pending = Promise.resolve();

  constructor(
    private readonly storage: Kept<Keys>,
    private readonly persistent: boolean,
  ) {}

  async get(id: string, target: string | undefined): Promise<string | undefined> {
    await this.pending;
    const saved = (await this.storage.load())?.[id];
    return saved?.target === target ? saved?.key : undefined;
  }

  async status(id?: string, target?: string): Promise<ConnectionKeyStatus> {
    const key = id && target ? await this.get(id, target) : undefined;
    return {
      present: key !== undefined,
      last4: key && key.length > 4 ? key.slice(-4) : undefined,
      persistent: this.persistent,
    };
  }

  /** Serialize edits and restore the key if saving the profile fails. */
  saveProfile(
    profile: AgentProfile,
    key: string | null | undefined,
    commit: () => void,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const target = connectionKeyTarget(profile.agent, profile.connection);
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

export async function openConnectionKeys(): Promise<ConnectionKeys> {
  const { app } = await import("electron");
  const box = await electronSecretBox().catch(() => undefined);
  if (!box) return new ConnectionKeys(keptInMemory(), false);
  return new ConnectionKeys(
    new SealedFile(join(app.getPath("userData"), "profile-api-keys.bin"), box, KeysSchema),
    box.available,
  );
}
