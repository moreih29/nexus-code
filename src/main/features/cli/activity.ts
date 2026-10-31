/**
 * What each terminal has been doing, for agents other than Claude Code: its
 * hooks report Claude's state, but Codex and other CLIs say only what their
 * output shows. A terminal's last output and the last notification it raised
 * (OSC 9/777/99, as Codex sends when a turn ends) stand in for that state.
 */
import { extractOscNotifications } from "../pty/osc-notification";

export interface TabActivity {
  /** When the terminal last printed anything. */
  readonly lastOutputAt: number;
  /** The last notification the terminal raised. */
  readonly lastNotice?: { readonly title?: string; readonly body: string; readonly at: number };
}

export interface ActivitySource {
  on(event: string, cb: (args: unknown) => void): () => void;
}

/** Keeps each live terminal's activity, keyed by workspace and tab. */
export class ActivityTracker {
  private readonly byTab = new Map<string, TabActivity>();
  private readonly disposers: Array<() => void> = [];

  constructor(
    source: ActivitySource,
    private readonly now: () => number = Date.now,
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
        this.byTab.delete(`${workspaceId}:${tabId}`);
      }),
    );
  }

  get(workspaceId: string, tabId: string): TabActivity | null {
    return this.byTab.get(`${workspaceId}:${tabId}`) ?? null;
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
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
    });
  }
}
