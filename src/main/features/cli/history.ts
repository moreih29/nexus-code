/**
 * What each terminal's agent did over time, for the sessions tab's timeline:
 * Claude Code's states as its hooks report them, spans of output from other
 * agents (busy as describeTerminal tells it), and waits on other terminals.
 * Spans are stored as they start and end, and kept for a day.
 */
import type { ClaudeStatus } from "../../../shared/claude/status";
import { BUSY_WINDOW_MS, type TerminalRef } from "../../../shared/sessions/agent-state";
import { SESSION_HISTORY_RETENTION_MS, type SessionSpan } from "../../../shared/sessions/history";
import type { ActivitySource } from "./activity";

export interface SessionSpanStore {
  startSessionSpan(span: Omit<SessionSpan, "end">): number;
  endSessionSpan(id: number, end: number): void;
  listSessionSpans(workspaceIds: readonly string[], since: number): SessionSpan[];
  endOpenSessionSpans(): void;
  pruneSessionSpans(before: number): void;
}

export interface ClaudeStatusSource {
  onChange(
    listener: (
      workspaceId: string,
      tabId: string,
      entry: { status: ClaudeStatus; since: number } | null,
    ) => void,
  ): () => void;
}

const PRUNE_EVERY_MS = 60 * 60_000;

export class SessionHistory {
  /** Each terminal's open Claude span. */
  private readonly claude = new Map<string, { id: number; status: ClaudeStatus }>();
  /** Each terminal's open span of output, when Claude's hooks don't tell its state. */
  private readonly busy = new Map<string, { id: number; lastOutputAt: number }>();
  /** Each waiting terminal's open wait spans. */
  private readonly waits = new Map<string, Set<number>>();
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly store: SessionSpanStore,
    source: ActivitySource,
    claude: ClaudeStatusSource,
    private readonly now: () => number = Date.now,
  ) {
    store.endOpenSessionSpans();
    this.prune();
    this.disposers.push(
      claude.onChange((workspaceId, tabId, entry) =>
        this.claudeChanged({ workspaceId, tabId }, entry),
      ),
      source.on("data", (args) => {
        const { workspaceId, tabId, replay } = args as TerminalRef & { replay?: boolean };
        // Replayed output is old output shown again.
        if (!replay) this.output({ workspaceId, tabId });
      }),
      source.on("exit", (args) => {
        const { workspaceId, tabId } = args as TerminalRef;
        this.exited(keyOf({ workspaceId, tabId }));
      }),
    );
    const sweep = setInterval(() => this.endQuiet(), BUSY_WINDOW_MS);
    const prune = setInterval(() => this.prune(), PRUNE_EVERY_MS);
    sweep.unref?.();
    prune.unref?.();
    this.disposers.push(
      () => clearInterval(sweep),
      () => clearInterval(prune),
    );
  }

  /** The spans of `workspaceIds` lasting until `since` or later. */
  list(workspaceIds: readonly string[], since: number): SessionSpan[] {
    return this.store.listSessionSpans(workspaceIds, since);
  }

  /** Records `waiter` waiting on `target` from `since`; the returned function ends it. */
  beginWait(waiter: TerminalRef, target: TerminalRef, since: number): () => void {
    const key = keyOf(waiter);
    const id = this.store.startSessionSpan({
      workspaceId: waiter.workspaceId,
      tabId: waiter.tabId,
      state: "waiting",
      start: since,
      target: { workspaceId: target.workspaceId, tabId: target.tabId },
    });
    const ids = this.waits.get(key) ?? new Set<number>();
    ids.add(id);
    this.waits.set(key, ids);
    return () => this.endWait(key, id, this.now());
  }

  /** Ends the spans of output that have gone quiet. */
  endQuiet(): void {
    const now = this.now();
    for (const [key, busy] of this.busy) {
      if (now - busy.lastOutputAt >= BUSY_WINDOW_MS) this.endBusy(key, now);
    }
  }

  /** Ends every open span, as the app quits. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    const now = this.now();
    for (const { id } of this.claude.values()) this.store.endSessionSpan(id, now);
    this.claude.clear();
    for (const key of [...this.busy.keys()]) this.endBusy(key, now);
    for (const key of [...this.waits.keys()]) this.exited(key);
  }

  private claudeChanged(
    terminal: TerminalRef,
    entry: { status: ClaudeStatus; since: number } | null,
  ): void {
    const key = keyOf(terminal);
    const open = this.claude.get(key);
    if (entry && open?.status === entry.status) return;
    const at = entry?.since ?? this.now();
    if (open) {
      this.store.endSessionSpan(open.id, at);
      this.claude.delete(key);
    }
    if (!entry) return;
    // Claude's hooks tell its state from here on, not its output.
    this.endBusy(key, at);
    const id = this.store.startSessionSpan({ ...terminal, state: entry.status, start: at });
    this.claude.set(key, { id, status: entry.status });
  }

  private output(terminal: TerminalRef): void {
    const key = keyOf(terminal);
    if (this.claude.has(key)) return;
    const at = this.now();
    const busy = this.busy.get(key);
    if (busy && at - busy.lastOutputAt < BUSY_WINDOW_MS) {
      busy.lastOutputAt = at;
      return;
    }
    this.endBusy(key, at);
    const id = this.store.startSessionSpan({ ...terminal, state: "busy", start: at });
    this.busy.set(key, { id, lastOutputAt: at });
  }

  /** Ends a span of output where it went quiet, or at `at` if sooner. */
  private endBusy(key: string, at: number): void {
    const busy = this.busy.get(key);
    if (!busy) return;
    this.busy.delete(key);
    this.store.endSessionSpan(busy.id, Math.min(busy.lastOutputAt + BUSY_WINDOW_MS, at));
  }

  private endWait(key: string, id: number, at: number): void {
    const ids = this.waits.get(key);
    if (!ids?.delete(id)) return;
    if (ids.size === 0) this.waits.delete(key);
    this.store.endSessionSpan(id, at);
  }

  /** A terminal that exited stops printing and waiting; Claude's broker clears its own. */
  private exited(key: string): void {
    const now = this.now();
    this.endBusy(key, now);
    for (const id of [...(this.waits.get(key) ?? [])]) this.endWait(key, id, now);
  }

  private prune(): void {
    this.store.pruneSessionSpans(this.now() - SESSION_HISTORY_RETENTION_MS);
  }
}

function keyOf(terminal: TerminalRef): string {
  return `${terminal.workspaceId}:${terminal.tabId}`;
}
