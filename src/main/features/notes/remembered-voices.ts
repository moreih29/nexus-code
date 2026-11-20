import { join } from "node:path";
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
import { electronSecretBox, type Kept, SealedFile, type SecretBox } from "../remote/sealed-file";

const DAY_MS = 24 * 60 * 60 * 1000;
const VoiceFileSchema = z.object({ version: z.literal(1), people: z.array(RememberedVoiceSchema) });
type VoiceFile = z.infer<typeof VoiceFileSchema>;

interface Preferences {
  read(): VoiceNameSettings;
  write(value: VoiceNameSettings): void;
}

export class RememberedVoices {
  private people: RememberedVoice[] | undefined;
  private revision = 0;
  private pending = Promise.resolve<unknown>(undefined);

  constructor(
    private readonly file: Kept<VoiceFile> | null,
    private readonly prefs: Preferences,
    private readonly changed: (status: VoiceNameStatus) => void,
    private readonly now = Date.now,
  ) {}

  private run<T>(task: (people: RememberedVoice[]) => T | Promise<T>): Promise<T> {
    const next = this.pending
      .catch(() => {})
      .then(async () => {
        this.people ??= (await this.file?.load())?.people ?? [];
        return task(this.people);
      });
    this.pending = next;
    return next;
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
    return this.run(() => this.snapshot());
  }

  list(): Promise<VoiceNamePerson[]> {
    return this.run((people) =>
      people.flatMap(({ name, recordings }) => {
        const latest = recordings[0];
        return latest ? [{ name, count: recordings.length, lastHeard: latest.recordedAt }] : [];
      }),
    );
  }

  consent(allowed: boolean): Promise<VoiceNameStatus> {
    return this.run(() => {
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
    return this.run((people) => {
      const { consent, suggest } = this.prefs.read();
      if (!this.file || consent !== "allowed" || !suggest || revision !== this.revision) return [];
      return suggestVoiceNames(people, candidates);
    });
  }

  learn({ revision, ...sample }: z.infer<typeof VoiceNameLearnArgsSchema>): Promise<boolean> {
    return this.run(async (people) => {
      const { consent, expire } = this.prefs.read();
      if (!this.file || revision !== this.revision || consent !== "allowed") return false;
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
    return this.run(() => {
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

  prune(): Promise<void> {
    return this.run((people) => this.sweep(people));
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
    ? new SealedFile(join(userData, "remembered-voices.bin"), box, VoiceFileSchema)
    : null;
}

export function registerRememberedVoices(
  userData: string,
  state: Pick<StateService, "getState" | "setState">,
) {
  const prefs: Preferences = {
    read: () => state.getState().rememberedVoices ?? VoiceNameSettingsSchema.parse({}),
    write: (rememberedVoices) => state.setState({ rememberedVoices }),
  };
  const ready = electronSecretBox()
    .catch(() => null)
    .then((box) => {
      const file = openVoiceMemoryFile(userData, box);
      return new RememberedVoices(file, prefs, (status) =>
        broadcast("voiceMemory", "changed", status),
      );
    });
  const prune = () => void ready.then((voices) => voices.prune()).catch(() => {});
  prune();
  const timer = setInterval(prune, DAY_MS);
  timer.unref();

  const c = ipcContract.voiceMemory.call;
  register("voiceMemory", {
    keepOnRendererClose: ["consent", "configure", "learn", "remove", "clear"],
    call: {
      status: async () => ipcOk(await (await ready).status()),
      list: async () => ipcOk(await (await ready).list()),
      consent: async (args) => {
        const { allowed } = validateArgs(c.consent.args, args);
        return ipcOk(await (await ready).consent(allowed));
      },
      configure: async (args) => {
        const patch = validateArgs(c.configure.args, args);
        return ipcOk(await (await ready).configure(patch));
      },
      match: async (args) => {
        const query = validateArgs(c.match.args, args);
        return ipcOk(await (await ready).match(query));
      },
      learn: async (args) => {
        const sample = validateArgs(c.learn.args, args);
        return ipcOk(await (await ready).learn(sample));
      },
      remove: async (args) => {
        const { name } = validateArgs(c.remove.args, args);
        return ipcOk(await (await ready).remove(name));
      },
      clear: async () => ipcOk(await (await ready).clear()),
    },
    listen: { changed: {} },
  });

  return {
    dispose: () => clearInterval(timer),
    waitForWrites: async () => (await ready).waitForWrites(),
  };
}
