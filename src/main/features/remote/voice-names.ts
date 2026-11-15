/**
 * The names of the moment a voice session sends along when the user turned
 * it on (voiceSendNames): this computer's workspaces, and the account's
 * other computers with their workspaces, as the agent view's Other
 * computers lists them. The speech recognition service then hears them as
 * they are written.
 *
 * A computer's workspaces come from its sessions' list: the one the agent
 * view watches, passed through here, or asked at the start of a session
 * when none came lately. A computer that does not answer in time keeps the
 * list it last gave, or gives none.
 */
import { clipTerm, MAX_VOICE_NAMES } from "../../../shared/remote/voice";

/** How long a computer is waited for when its workspaces are asked at a session's start. */
export const NAMES_ASK_MS = 1500;
/** How long a computer's list stands before a session's start asks it again. */
export const NAMES_FRESH_MS = 60_000;

/** A computer of the Other computers list. */
export interface NamedComputer {
  id: string;
  name: string;
  /** In the room, serving its sessions' list: its workspaces can be asked. */
  serving: boolean;
}

/** The part of a sessions' list read here. */
export interface ListedWorkspaces {
  workspaces: readonly { name: string }[];
}

/** The systems the desktop app runs on: the list keeps an offline phone out. */
const DESKTOPS = new Set(["darwin", "win32", "linux"]);

/**
 * The computers the Other computers list shows: those in the room that
 * serve their sessions, and the desktops out of it; none while this one is
 * out of the room.
 */
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

/**
 * The names in the order given, trimmed and clipped to the length a term
 * may have, each once whatever its case, the empty ones left out: at most
 * MAX_VOICE_NAMES.
 */
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
  /** Whether the user turned the names on. */
  enabled(): boolean;
  /** This computer's workspaces, by name. */
  workspaces(): readonly string[];
  /** The account's other computers, as the Other computers list shows them. */
  computers(): readonly NamedComputer[];
  /** Asks a computer for its sessions' list. */
  list(deviceId: string, timeoutMs: number): Promise<ListedWorkspaces>;
  now?: () => number;
}

export class VoiceNames {
  /** Each computer's workspaces, by name, as its list last said, and when. */
  private readonly listed = new Map<string, { names: string[]; at: number }>();

  constructor(private readonly deps: VoiceNamesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** A computer's sessions' list came: asked, or told as it changed. */
  took(deviceId: string, list: ListedWorkspaces): void {
    this.listed.set(deviceId, { names: list.workspaces.map((w) => w.name), at: this.now() });
  }

  /** The names to send now: none while they are off. */
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
          } catch {
            // Not answered in time, or gone: the list it last gave stands.
          }
        }),
    );
    return voiceNamesOf([
      computers.map((c) => c.name),
      this.deps.workspaces(),
      ...computers.map((c) => this.listed.get(c.id)?.names ?? []),
    ]);
  }
}
