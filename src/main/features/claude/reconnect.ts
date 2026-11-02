/**
 * Claude Code's hooks reach the app over the agent's link. While an SSH
 * outage holds a workspace's terminals, the hooks Claude runs are lost, so a
 * turn that ended then leaves its terminal "running" until the next hook.
 * When the terminals come back, each one with a Claude state is looked at
 * again, through what the terminal itself shows once its output is replayed:
 *
 * - Its foreground program is a shell again: Claude Code exited, and the
 *   state goes.
 * - It was running, and the last title in the replayed output has the ✳ mark
 *   Claude shows while it waits on the user: the turn ended, or stopped on a
 *   question, and the state becomes needsInput.
 *
 * Anything else keeps the state. The state changes once, after the replay,
 * and only on such a sign, so it never flickers while the replay comes in.
 */
import { isLoginShell } from "../../../shared/pty/login-shell";
import type { ClaudeStatusBroker } from "./status";

/** The mark Claude Code puts at the start of its title between turns. */
const IDLE_MARK = "✳";

/** A terminal title, set with OSC 0 or 2 and ended by BEL or ST. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** The most of an unended sequence kept for the next chunk. */
const MAX_CARRY = 1024;

interface Restoring {
  /** The state when the terminal came back, to see whether a hook changed it since. */
  readonly status: string;
  readonly since: number;
  /** The last title in the replayed output so far. */
  title: string | undefined;
  /** A sequence the last chunk ended inside. */
  carry: string;
}

export class ClaudeReconnectCheck {
  private readonly restoring = new Map<string, Restoring>();

  constructor(
    private readonly broker: Pick<ClaudeStatusBroker, "get" | "set" | "clear">,
    /** The terminal's foreground program, or null when it cannot be told. */
    private readonly foregroundProcess: (
      workspaceId: string,
      tabId: string,
    ) => Promise<string | null>,
  ) {}

  /** A held terminal came back; with replay, its output is about to be sent again. */
  noteRestored(workspaceId: string, tabId: string, withReplay: boolean): void {
    const key = `${workspaceId}:${tabId}`;
    const entry = this.broker.get(workspaceId, tabId);
    if (!withReplay || entry === null) {
      this.restoring.delete(key);
      return;
    }
    this.restoring.set(key, {
      status: entry.status,
      since: entry.since,
      title: undefined,
      carry: "",
    });
  }

  /** Output replayed to a terminal. */
  noteReplay(workspaceId: string, tabId: string, chunk: string): void {
    const restoring = this.restoring.get(`${workspaceId}:${tabId}`);
    if (restoring === undefined) return;
    const text = restoring.carry + chunk;
    let end = 0;
    for (const match of text.matchAll(TITLE)) {
      restoring.title = match[1];
      end = match.index + match[0].length;
    }
    const open = text.lastIndexOf("\x1b]");
    if (open >= end && text.length - open <= MAX_CARRY) restoring.carry = text.slice(open);
    else restoring.carry = text.endsWith("\x1b") ? "\x1b" : "";
  }

  /** The replay ended: decides the terminal's state from what it showed. */
  async noteReplayed(workspaceId: string, tabId: string): Promise<void> {
    const key = `${workspaceId}:${tabId}`;
    const restoring = this.restoring.get(key);
    if (restoring === undefined) return;
    this.restoring.delete(key);
    if (!this.unchanged(workspaceId, tabId, restoring)) return;

    const program = await this.foregroundProcess(workspaceId, tabId).catch(() => null);
    // A hook may have come in meanwhile, and it knows better.
    if (!this.unchanged(workspaceId, tabId, restoring)) return;
    if (program !== null && isLoginShell(program)) {
      this.broker.clear(workspaceId, tabId);
      return;
    }
    if (restoring.status === "running" && restoring.title?.startsWith(IDLE_MARK)) {
      this.broker.set(workspaceId, tabId, "needsInput");
    }
  }

  /** Forgets a terminal that ended. */
  forget(workspaceId: string, tabId: string): void {
    this.restoring.delete(`${workspaceId}:${tabId}`);
  }

  private unchanged(workspaceId: string, tabId: string, restoring: Restoring): boolean {
    const entry = this.broker.get(workspaceId, tabId);
    return entry !== null && entry.status === restoring.status && entry.since === restoring.since;
  }
}
