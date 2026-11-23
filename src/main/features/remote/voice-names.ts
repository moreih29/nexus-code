import { clipTerm, MAX_VOICE_NAMES } from "../../../shared/remote/voice";

export const NAMES_ASK_MS = 1500;
export const NAMES_FRESH_MS = 60_000;

export interface NamedComputer {
  id: string;
  name: string;
  serving: boolean;
}

export interface ListedWorkspaces {
  workspaces: readonly { name: string }[];
}

const DESKTOPS = new Set(["darwin", "win32", "linux"]);

export function listedComputers(room: {
  status: string;
  peers: readonly {
    id: string;
    name: string;
    platform: string;
    online: boolean;
    serves?: readonly string[];
  }[];
}): NamedComputer[] {
  if (room.status !== "online") return [];
  return room.peers.flatMap((p) => {
    const serving = p.online && (p.serves?.includes("sessions") ?? false);
    return serving || (!p.online && DESKTOPS.has(p.platform))
      ? [{ id: p.id, name: p.name, serving }]
      : [];
  });
}

export function voiceNamesOf(groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const name = clipTerm(raw.trim()).trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length >= MAX_VOICE_NAMES) return names;
    }
  }
  return names;
}

export interface VoiceNamesDeps {
  enabled(): boolean;
  workspaces(): readonly string[];
  computers(): readonly NamedComputer[];
  list(deviceId: string, timeoutMs: number): Promise<ListedWorkspaces>;
  now?: () => number;
}

export class VoiceNames {
  private readonly listed = new Map<string, { names: string[]; at: number }>();

  constructor(private readonly deps: VoiceNamesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  took(deviceId: string, list: ListedWorkspaces): void {
    this.listed.set(deviceId, { names: list.workspaces.map((w) => w.name), at: this.now() });
  }

  async collect(): Promise<string[]> {
    if (!this.deps.enabled()) return [];
    const computers = this.deps.computers();
    const stale = (id: string) => {
      const entry = this.listed.get(id);
      return !entry || this.now() - entry.at > NAMES_FRESH_MS;
    };
    await Promise.all(
      computers
        .filter((c) => c.serving && stale(c.id))
        .map(async (c) => {
          try {
            this.took(c.id, await this.deps.list(c.id, NAMES_ASK_MS));
          } catch {}
        }),
    );
    return voiceNamesOf([
      computers.map((c) => c.name),
      this.deps.workspaces(),
      ...computers.map((c) => this.listed.get(c.id)?.names ?? []),
    ]);
  }
}
