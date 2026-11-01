/**
 * Claude Code that dies without its SessionEnd hook (a crash, SIGKILL, the
 * OOM killer) leaves its state behind: the tab reads as running for good, its
 * timeline span stays open and nexus terminal wait on it never returns. When
 * a Claude tab's output goes quiet, as it does once the shell has printed its
 * prompt, the program in its foreground is looked at: the shell back there
 * means Claude is gone, and its state is cleared as SessionEnd clears it.
 */
import { isLoginShell } from "../../../shared/pty/login-shell";
import { BUSY_WINDOW_MS } from "../../../shared/sessions/agent-state";
import type { ActivitySource, ForegroundLookup } from "./activity";

/** Claude Code's state per terminal, as the hooks' broker keeps it. */
export interface ClaudeEntries {
  get(workspaceId: string, tabId: string): { since: number } | null;
  clear(workspaceId: string, tabId: string): void;
}

export class ClaudeExitWatch {
  /** When each Claude tab last printed. */
  private readonly lastOutputAt = new Map<string, number>();
  /** Each Claude tab's timer for its output going quiet. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposers: Array<() => void> = [];

  constructor(
    source: ActivitySource,
    private readonly claude: ClaudeEntries,
    private readonly foreground: ForegroundLookup,
    private readonly now: () => number = Date.now,
    private readonly quietMs: number = BUSY_WINDOW_MS,
  ) {
    this.disposers.push(
      source.on("data", (args) => {
        const { workspaceId, tabId, replay } = args as {
          workspaceId: string;
          tabId: string;
          replay?: boolean;
        };
        // Replayed output is old output shown again; tabs without Claude have nothing to clear.
        if (replay || !claude.get(workspaceId, tabId)) return;
        this.output(workspaceId, tabId);
      }),
      source.on("exit", (args) => {
        const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
        this.forget(`${workspaceId}:${tabId}`);
      }),
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const key of [...this.timers.keys()]) this.forget(key);
  }

  private output(workspaceId: string, tabId: string): void {
    const key = `${workspaceId}:${tabId}`;
    this.lastOutputAt.set(key, this.now());
    if (!this.timers.has(key)) this.arm(workspaceId, tabId, this.quietMs);
  }

  /** Looks once output has been quiet for quietMs, not on every chunk. */
  private arm(workspaceId: string, tabId: string, delay: number): void {
    const key = `${workspaceId}:${tabId}`;
    this.timers.set(
      key,
      setTimeout(() => {
        const quietFor = this.now() - (this.lastOutputAt.get(key) ?? 0);
        if (quietFor < this.quietMs) {
          this.arm(workspaceId, tabId, this.quietMs - quietFor);
          return;
        }
        this.forget(key);
        void this.check(workspaceId, tabId);
      }, delay),
    );
  }

  private async check(workspaceId: string, tabId: string): Promise<void> {
    const askedAt = this.now();
    let program: string | null;
    try {
      program = await this.foreground(workspaceId, tabId);
    } catch {
      return;
    }
    // Claude, or a program it runs: Claude Code installed with npm is "node".
    if (program === null || !isLoginShell(program)) return;
    const entry = this.claude.get(workspaceId, tabId);
    // A state set while the program was looked up is a Claude started since.
    if (entry && entry.since <= askedAt) this.claude.clear(workspaceId, tabId);
  }

  private forget(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.lastOutputAt.delete(key);
  }
}
