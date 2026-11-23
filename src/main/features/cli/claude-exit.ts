import { isLoginShell } from "../../../shared/pty/login-shell";
import { BUSY_WINDOW_MS } from "../../../shared/sessions/agent-state";
import type { ActivitySource } from "./activity";

export type ForegroundGroupLookup = (
  workspaceId: string,
  tabId: string,
) => Promise<{ name: string; alone: boolean | undefined } | null>;

export interface ClaudeEntries {
  get(workspaceId: string, tabId: string): { since: number } | null;
  clear(workspaceId: string, tabId: string): void;
}

export class ClaudeExitWatch {
  private readonly lastOutputAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lookups = new Map<string, symbol>();
  private readonly disposers: Array<() => void> = [];

  constructor(
    source: ActivitySource,
    private readonly claude: ClaudeEntries,
    private readonly foreground: ForegroundGroupLookup,
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
    this.lookups.clear();
  }

  private output(workspaceId: string, tabId: string): void {
    const key = `${workspaceId}:${tabId}`;
    this.lookups.delete(key);
    this.lastOutputAt.set(key, this.now());
    if (!this.timers.has(key)) this.arm(workspaceId, tabId, this.quietMs);
  }

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
    const entry = this.claude.get(workspaceId, tabId);
    if (!entry) return;
    const key = `${workspaceId}:${tabId}`;
    const lookup = Symbol();
    this.lookups.set(key, lookup);
    let front: Awaited<ReturnType<ForegroundGroupLookup>>;
    try {
      front = await this.foreground(workspaceId, tabId);
    } catch {
      front = null;
    }
    if (this.lookups.get(key) !== lookup) return;
    this.lookups.delete(key);
    if (front === null || !isLoginShell(front.name) || front.alone === false) return;
    if (this.claude.get(workspaceId, tabId) === entry) this.claude.clear(workspaceId, tabId);
  }

  private forget(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.lastOutputAt.delete(key);
    this.lookups.delete(key);
  }
}
