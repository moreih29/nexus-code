import { isLoginShell } from "../../../shared/pty/login-shell";
import {
  agentFromProgram,
  BUSY_WINDOW_MS,
  ECHO_MS,
  type TabActivity,
  type TabActivityEntry,
} from "../../../shared/sessions/agent-state";
import { extractOscNotifications } from "../pty/osc-notification";

export type { TabActivity } from "../../../shared/sessions/agent-state";

export interface ActivitySource {
  on(event: string, cb: (args: unknown) => void): () => void;
}

export type ForegroundLookup = (workspaceId: string, tabId: string) => Promise<string | null>;

export const PROGRAM_SETTLE_MS = 3_000;

export class ActivityTracker {
  private readonly byTab = new Map<string, TabActivity>();
  private readonly disposers: Array<() => void> = [];
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lookedAt = new Map<string, number>();
  private readonly typedAt = new Map<string, number>();
  private readonly resizedAt = new Map<string, number>();

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
        this.typedAt.delete(key);
        this.resizedAt.delete(key);
      }),
    );
  }

  noteInput(workspaceId: string, tabId: string): void {
    this.typedAt.set(`${workspaceId}:${tabId}`, this.now());
  }

  noteResize(workspaceId: string, tabId: string): void {
    this.resizedAt.set(`${workspaceId}:${tabId}`, this.now());
  }

  get(workspaceId: string, tabId: string): TabActivity | null {
    return this.byTab.get(`${workspaceId}:${tabId}`) ?? null;
  }

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
    this.typedAt.clear();
    this.resizedAt.clear();
    this.byTab.clear();
  }

  private record(workspaceId: string, tabId: string, chunk: string): void {
    const key = `${workspaceId}:${tabId}`;
    const at = this.now();
    const previous = this.byTab.get(key);
    const notices = extractOscNotifications(chunk);
    const notice = notices[notices.length - 1];
    const typed = this.typedAt.get(key);
    const echo = typed !== undefined && at - typed < ECHO_MS;
    const resized = this.resizedAt.get(key);
    const redraw =
      previous !== undefined &&
      resized !== undefined &&
      at - resized < ECHO_MS &&
      resized - previous.lastOutputAt >= BUSY_WINDOW_MS;
    if ((echo || redraw) && !notice) return;
    this.byTab.set(key, {
      lastOutputAt: (echo || redraw) && previous ? previous.lastOutputAt : at,
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
        if (this.settleTimers.has(key)) return;
        if ((this.lookedAt.get(key) ?? 0) < current.lastOutputAt) {
          void this.lookProgram(workspaceId, tabId);
        }
      }, delay),
    );
  }

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
