import { join } from "node:path";
import type { WebContents } from "electron";
import { z } from "zod";
import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import {
  type RememberedVoice,
  RememberedVoiceSchema,
  suggestVoiceNames,
  VOICE_NAME_RETENTION_MS,
  type VoiceNameLearnArgsSchema,
  type VoiceNameMatchArgsSchema,
  type VoiceNamePerson,
  type VoiceNameSettings,
  VoiceNameSettingsSchema,
  type VoiceNameStatus,
  withRememberedVoice,
} from "../../../shared/notes/voice-names";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";
import { SEALED_FILES } from "../keychain/files";
import type { Keychain } from "../keychain/gate";
import { type Kept, KeychainLockedError, SealedFile, type SecretBox } from "../remote/sealed-file";

const DAY_MS = 24 * 60 * 60 * 1000;
const VoiceFileSchema = z.object({ version: z.literal(1), people: z.array(RememberedVoiceSchema) });
type VoiceFile = z.infer<typeof VoiceFileSchema>;

interface Preferences {
  read(): VoiceNameSettings;
  write(value: VoiceNameSettings): void;
}

/** The keychain as the voices wait on it; always open where none asks first. */
type VoicesKeychain = Pick<Keychain, "isOpen" | "unlock">;
const ALWAYS_OPEN: VoicesKeychain = { isOpen: () => true, unlock: async () => true };

export class RememberedVoices {
  private people: RememberedVoice[] | undefined;
  private revision = 0;
  private pending = Promise.resolve<unknown>(undefined);

  constructor(
    private readonly file: Kept<VoiceFile> | null,
    private readonly prefs: Preferences,
    private readonly changed: (status: VoiceNameStatus) => void,
    private readonly now = Date.now,
    private readonly keychain: VoicesKeychain = ALWAYS_OPEN,
  ) {}

  /** One at a time, in order. */
  private queue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(task);
    this.pending = next;
    return next;
  }

  /**
   * The people, read once. A read in the background waits on a locked
   * keychain (null); one for what the user does opens it, or throws
   * KeychainLockedError while it stays locked. A locked read is not kept as
   * none, so nothing written after it drops the people sealed.
   */
  private async load(user: boolean): Promise<RememberedVoice[] | null> {
    if (this.people) return this.people;
    if (this.file && !this.keychain.isOpen()) {
      if (!user) return null;
      if (!(await this.keychain.unlock())) throw new KeychainLockedError();
    }
    this.people = (await this.file?.load())?.people ?? [];
    return this.people;
  }

  /** For what the user does: the people, opening a locked keychain. */
  private run<T>(task: (people: RememberedVoice[]) => T | Promise<T>): Promise<T> {
    return this.queue(async () => task((await this.load(true)) ?? []));
  }

  /**
   * For what the app does by itself: the people if they can be read without
   * asking, null otherwise. A refusal meanwhile is none here, unless told to
   * throw it (a read that waits for the next opening).
   */
  private peek<T>(
    task: (people: RememberedVoice[] | null) => T | Promise<T>,
    refused: "none" | "throw" = "none",
  ): Promise<T> {
    return this.queue(async () => {
      const people = await this.load(false).catch((error: unknown) => {
        if (refused === "none" && error instanceof KeychainLockedError) return null;
        throw error;
      });
      return task(people);
    });
  }

  private async save(people: RememberedVoice[], invalidate: boolean): Promise<void> {
    if (!this.file) return;
    if (people.length) await this.file.save({ version: 1, people });
    else this.file.clear();
    this.people = people;
    this.notify(invalidate);
  }

  private snapshot(): VoiceNameStatus {
    return {
      ...this.prefs.read(),
      available: this.file !== null,
      revision: this.revision,
      count: this.people?.length ?? 0,
    };
  }

  private notify(invalidate: boolean): void {
    if (invalidate) this.revision++;
    this.changed(this.snapshot());
  }

  status(): Promise<VoiceNameStatus> {
    return this.peek(() => this.snapshot());
  }

  list(): Promise<VoiceNamePerson[]> {
    return this.peek((people) =>
      (people ?? []).flatMap(({ name, recordings }) => {
        const latest = recordings[0];
        return latest ? [{ name, count: recordings.length, lastHeard: latest.recordedAt }] : [];
      }),
    );
  }

  /** Agreeing opens a locked keychain, as remembering a voice will need it. */
  consent(allowed: boolean): Promise<VoiceNameStatus> {
    return this.queue(async () => {
      if (allowed && this.file && !this.keychain.isOpen()) await this.keychain.unlock();
      const before = this.prefs.read();
      if (this.file && before.consent === "pending") {
        this.prefs.write({
          ...before,
          consent: allowed ? "allowed" : "declined",
          suggest: allowed && before.suggest,
        });
        this.notify(true);
      }
      return this.snapshot();
    });
  }

  configure(
    patch: Partial<Pick<VoiceNameSettings, "suggest" | "expire">>,
  ): Promise<VoiceNameStatus> {
    return this.run(async (people) => {
      const before = this.prefs.read();
      const suggest = patch.suggest ?? before.suggest;
      const expire = patch.expire ?? before.expire;
      if (this.file && (suggest !== before.suggest || expire !== before.expire)) {
        const after = { ...before, suggest, expire };
        if (after.suggest && after.consent === "declined") after.consent = "allowed";
        this.prefs.write(after);
        this.notify(true);
        if (after.expire && !before.expire) await this.sweep(people);
      }
      return this.snapshot();
    });
  }

  match({ revision, ...candidates }: z.infer<typeof VoiceNameMatchArgsSchema>) {
    return this.peek((people) => {
      const { consent, suggest } = this.prefs.read();
      if (!this.file || consent !== "allowed" || !suggest || revision !== this.revision) return [];
      return people ? suggestVoiceNames(people, candidates) : [];
    });
  }

  /** Remembering a voice opens a locked keychain; false while it stays locked. */
  learn({ revision, ...sample }: z.infer<typeof VoiceNameLearnArgsSchema>): Promise<boolean> {
    return this.queue(async () => {
      const { consent, expire } = this.prefs.read();
      if (!this.file || revision !== this.revision || consent !== "allowed") return false;
      const people = await this.load(true).catch((error: unknown) => {
        if (error instanceof KeychainLockedError) return null;
        throw error;
      });
      if (!people) return false;
      if (expire && sample.recordedAt <= this.now() - VOICE_NAME_RETENTION_MS) return false;
      const at = people.findIndex((p) => p.name === sample.name);
      const updated = withRememberedVoice(people[at], sample);
      if (!updated) return false;
      const next = [...people];
      if (at < 0) next.push(updated);
      else next[at] = updated;
      await this.save(next, false);
      return true;
    });
  }

  remove(name: string): Promise<void> {
    return this.run(async (people) => {
      const next = people.filter((p) => p.name !== name);
      if (next.length !== people.length) await this.save(next, true);
    });
  }

  clear(): Promise<void> {
    return this.queue(() => {
      this.file?.clear();
      this.people = [];
      this.notify(true);
    });
  }

  private async sweep(people: RememberedVoice[]): Promise<void> {
    if (!this.prefs.read().expire) return;
    const cutoff = this.now() - VOICE_NAME_RETENTION_MS;
    const current = people.filter((p) => (p.recordings[0]?.recordedAt ?? 0) > cutoff);
    if (people.length !== current.length) await this.save(current, true);
  }

  /** Forgets voices not heard for a year; run once the keychain is open (Keychain.whenOpen). */
  prune(): Promise<void> {
    return this.peek(async (people) => {
      if (people) await this.sweep(people);
    }, "throw");
  }

  async waitForWrites(): Promise<void> {
    await this.pending.catch(() => {});
  }
}

export function openVoiceMemoryFile(
  userData: string,
  box: SecretBox | null,
): Kept<VoiceFile> | null {
  return box?.available
    ? new SealedFile(join(userData, SEALED_FILES.voices), box, VoiceFileSchema)
    : null;
}

export function registerRememberedVoices(
  userData: string,
  state: Pick<StateService, "getState" | "commitState">,
  keychain: Keychain,
) {
  const prefs: Preferences = {
    read: () => state.getState().rememberedVoices ?? VoiceNameSettingsSchema.parse({}),
    write: (rememberedVoices) => state.commitState({ rememberedVoices }),
  };
  const changed = (status: VoiceNameStatus) => broadcast("voiceMemory", "changed", status);
  const voices = new RememberedVoices(
    openVoiceMemoryFile(userData, keychain.box),
    prefs,
    changed,
    Date.now,
    keychain,
  );
  // Once the keychain opens: the voices are read, pruned, and counted for the windows.
  const prune = () =>
    void keychain.whenOpen("voices", async () => {
      await voices.prune();
      changed(await voices.status());
    });
  prune();
  const timer = setInterval(prune, DAY_MS);
  timer.unref();

  let consentPrompt: { owner: WebContents; done: Promise<void>; release: () => void } | undefined;
  let disposed = false;

  /** The first saving window asks. Others wait for that choice or for its window to close. */
  async function claimConsent(
    owner?: WebContents,
  ): Promise<{ prompt: boolean; status: VoiceNameStatus }> {
    while (true) {
      const status = await voices.status();
      if (
        disposed ||
        !owner ||
        owner.isDestroyed() ||
        !status.available ||
        status.consent !== "pending"
      ) {
        return { prompt: false, status };
      }
      if (!consentPrompt) {
        let resolve = () => {};
        const done = new Promise<void>((settled) => {
          resolve = settled;
        });
        const release = () => {
          if (consentPrompt?.release !== release) return;
          consentPrompt = undefined;
          owner.removeListener("destroyed", release);
          resolve();
        };
        consentPrompt = { owner, done, release };
        owner.once("destroyed", release);
      }
      if (consentPrompt.owner === owner) return { prompt: true, status };
      await consentPrompt.done;
    }
  }

  const c = ipcContract.voiceMemory.call;
  register("voiceMemory", {
    keepOnRendererClose: ["consent", "configure", "learn", "remove", "clear"],
    call: {
      status: async () => ipcOk(await voices.status()),
      list: async () => ipcOk(await voices.list()),
      claimConsent: async (_args, ctx) => ipcOk(await claimConsent(ctx?.sender)),
      consent: async (args, ctx) => {
        const { allowed } = validateArgs(c.consent.args, args);
        const prompt = consentPrompt;
        if (!prompt || prompt.owner !== ctx?.sender) return ipcOk(await voices.status());
        try {
          return ipcOk(await voices.consent(allowed));
        } finally {
          prompt.release();
        }
      },
      configure: async (args) => {
        const patch = validateArgs(c.configure.args, args);
        return ipcOk(await voices.configure(patch));
      },
      match: async (args) => {
        const query = validateArgs(c.match.args, args);
        return ipcOk(await voices.match(query));
      },
      learn: async (args) => {
        const sample = validateArgs(c.learn.args, args);
        return ipcOk(await voices.learn(sample));
      },
      remove: async (args) => {
        const { name } = validateArgs(c.remove.args, args);
        return ipcOk(await voices.remove(name));
      },
      clear: async () => ipcOk(await voices.clear()),
    },
    listen: { changed: {} },
  });

  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      consentPrompt?.release();
    },
    waitForWrites: () => voices.waitForWrites(),
  };
}
