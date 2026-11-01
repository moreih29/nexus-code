/**
 * What each terminal has been doing, for agents other than Claude Code: its
 * hooks report Claude's state, but Codex and other CLIs say only what their
 * output shows. A terminal's last output and the last notification it raised
 * (OSC 9/777/99, as Codex sends when a turn ends) stand in for that state,
 * and the program in its foreground tells which agent it is.
 */
import {
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

  constructor(
    source: ActivitySource,
    private readonly now: () => number = Date.now,
    private readonly foreground?: ForegroundLookup,
    private readonly settleMs: number = PROGRAM_SETTLE_MS,
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
  }

  /**
   * Looks at the terminal's foreground program as output starts after a quiet
   * spell, and once more when it has settled, for a program it started.
   */
  private watchProgram(workspaceId: string, tabId: string): void {
    const lookup = this.foreground;
    if (!lookup) return;
    const key = `${workspaceId}:${tabId}`;
    const look = () =>
      lookup(workspaceId, tabId).then(
        (program) => {
          const current = this.byTab.get(key);
          if (current) this.byTab.set(key, { ...current, program: program ?? undefined });
        },
        () => {},
      );
    void look();
    clearTimeout(this.settleTimers.get(key));
    this.settleTimers.set(
      key,
      setTimeout(() => {
        this.settleTimers.delete(key);
        void look();
      }, this.settleMs),
    );
  }
}
