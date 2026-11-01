/**
 * What each terminal has been doing, for agents other than Claude Code: its
 * hooks report Claude's state, but Codex and other CLIs say only what their
 * output shows. A terminal's last output and the last notification it raised
 * (OSC 9/777/99, as Codex sends when a turn ends) stand in for that state,
 * and the program in its foreground tells which agent it is.
 */
import { isLoginShell } from "../../../shared/pty/login-shell";
import {
  agentFromProgram,
  BUSY_WINDOW_MS,
  type TabActivity,
  type TabActivityEntry,
} from "../../../shared/sessions/agent-state";
import { extractOscNotifications } from "../pty/osc-notification";

export type { TabActivity } from "../../../shared/sessions/agent-state";

export interface ActivitySource {
  on(event: string, cb: (args: unknown) => void): () => void;
}

/** Names the program in a terminal's foreground, or null when it cannot be told. */
export type ForegroundLookup = (workspaceId: string, tabId: string) => Promise<string | null>;

/**
 * How long after output starts the foreground is looked at again: a program
 * started then, as a task's agent is right after its shell, has it by now.
 */
export const PROGRAM_SETTLE_MS = 3_000;

/** Keeps each live terminal's activity, keyed by workspace and tab. */
export class ActivityTracker {
  private readonly byTab = new Map<string, TabActivity>();
  private readonly disposers: Array<() => void> = [];
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each terminal's timer for its output going quiet. */
  private readonly quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each terminal's foreground program was last asked for. */
  private readonly lookedAt = new Map<string, number>();

  constructor(
    source: ActivitySource,
    private readonly now: () => number = Date.now,
    private readonly foreground?: ForegroundLookup,
    private readonly settleMs: number = PROGRAM_SETTLE_MS,
    private readonly quietMs: number = BUSY_WINDOW_MS,
  ) {
    this.disposers.push(
      source.on("data", (args) => {
        const { workspaceId, tabId, chunk, replay } = args as {
          workspaceId: string;
          tabId: string;
          chunk: string;
          replay?: boolean;
        };
        // Replayed output is old output shown again.
        if (replay) return;
        this.record(workspaceId, tabId, chunk);
      }),
      source.on("exit", (args) => {
        const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
        const key = `${workspaceId}:${tabId}`;
        this.byTab.delete(key);
        clearTimeout(this.settleTimers.get(key));
        this.settleTimers.delete(key);
        clearTimeout(this.quietTimers.get(key));
        this.quietTimers.delete(key);
        this.lookedAt.delete(key);
      }),
    );
  }

  get(workspaceId: string, tabId: string): TabActivity | null {
    return this.byTab.get(`${workspaceId}:${tabId}`) ?? null;
  }

  /** Every live terminal's activity, for the app's sessions view. */
  snapshot(): TabActivityEntry[] {
    return [...this.byTab].map(([key, activity]) => {
      const colon = key.indexOf(":");
      return { workspaceId: key.slice(0, colon), tabId: key.slice(colon + 1), ...activity };
    });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
    for (const timer of this.quietTimers.values()) clearTimeout(timer);
    this.quietTimers.clear();
    this.lookedAt.clear();
    this.byTab.clear();
  }

  private record(workspaceId: string, tabId: string, chunk: string): void {
    const key = `${workspaceId}:${tabId}`;
    const at = this.now();
    const previous = this.byTab.get(key);
    const notices = extractOscNotifications(chunk);
    const notice = notices[notices.length - 1];
    this.byTab.set(key, {
      lastOutputAt: at,
      lastNotice: notice
        ? { ...(notice.title ? { title: notice.title } : {}), body: notice.body, at }
        : previous?.lastNotice,
      program: previous?.program,
    });
    if (!previous || at - previous.lastOutputAt >= BUSY_WINDOW_MS) {
      this.watchProgram(workspaceId, tabId);
    }
    if (this.foreground && !this.quietTimers.has(key)) this.watchQuiet(workspaceId, tabId);
  }

  /**
   * Looks at the foreground program again once output goes quiet, when the
   * last look was before output ended: an agent that printed until it exited,
   * as Codex does, has left the shell in front, which no look has seen.
   */
  private watchQuiet(workspaceId: string, tabId: string, delay = this.quietMs): void {
    const key = `${workspaceId}:${tabId}`;
    this.quietTimers.set(
      key,
      setTimeout(() => {
        this.quietTimers.delete(key);
        const current = this.byTab.get(key);
        if (!current) return;
        const quietFor = this.now() - current.lastOutputAt;
        if (quietFor < this.quietMs) {
          this.watchQuiet(workspaceId, tabId, this.quietMs - quietFor);
          return;
        }
        // The look once output settles comes after this, and sees it.
        if (this.settleTimers.has(key)) return;
        if ((this.lookedAt.get(key) ?? 0) < current.lastOutputAt) {
          void this.lookProgram(workspaceId, tabId);
        }
      }, delay),
    );
  }

  /**
   * Looks at the terminal's foreground program as output starts after a quiet
   * spell, and once more when it has settled, for a program it started.
   */
  private watchProgram(workspaceId: string, tabId: string): void {
    const lookup = this.foreground;
    if (!lookup) return;
    const key = `${workspaceId}:${tabId}`;
    void this.lookProgram(workspaceId, tabId);
    clearTimeout(this.settleTimers.get(key));
    this.settleTimers.set(
      key,
      setTimeout(() => {
        this.settleTimers.delete(key);
        void this.lookProgram(workspaceId, tabId);
      }, this.settleMs),
    );
  }

  /**
   * Records the terminal's foreground program. An agent that has given the
   * shell back is gone, and so is what it last notified: its session ended.
   */
  private async lookProgram(workspaceId: string, tabId: string): Promise<void> {
    const lookup = this.foreground;
    if (!lookup) return;
    const key = `${workspaceId}:${tabId}`;
    const askedAt = this.now();
    this.lookedAt.set(key, askedAt);
    let program: string | null;
    try {
      program = await lookup(workspaceId, tabId);
    } catch {
      return;
    }
    const current = this.byTab.get(key);
    if (!current) return;
    const { lastNotice, ...rest } = current;
    const ended =
      agentFromProgram(current.program) !== undefined && program !== null && isLoginShell(program);
    this.byTab.set(key, {
      ...rest,
      ...(lastNotice && !(ended && lastNotice.at <= askedAt) ? { lastNotice } : {}),
      program: program ?? undefined,
    });
  }
}
