/**
 * Per-workspace status refresh coalescer. Bursty triggers use a trailing
 * debounce, while triggers received during an active run collapse into one
 * follow-up run after the active run settles. Triggers that land inside the
 * post-refresh suppression window are deferred to the window's end — never
 * dropped (see `suppressionMs`).
 */

import { createLogger } from "../../../../shared/log/main";
import { createKeyedDebouncer, type KeyedDebouncer } from "../../../../shared/util/keyed-debouncer";
import {
  defaultTimerScheduler,
  type TimerScheduler,
} from "../../../../shared/util/timer-scheduler";

const log = createLogger("git");

/**
 * Consecutive window-deferred runs allowed before deferrals back off to
 * `DEFERRED_BACKOFF_MS`. Bounds the cost of a self-induced loop on a git too
 * old to honour GIT_OPTIONAL_LOCKS (< 2.15, e.g. stock CentOS 7 over SSH),
 * where every `git status` still rewrites the index.
 */
const DEFERRED_CHAIN_LIMIT = 5;
const DEFERRED_BACKOFF_MS = 5_000;

export type StatusRunFn = () => Promise<void> | void;

export interface StatusCoalescer {
  schedule(workspaceId: string, runFn: StatusRunFn): void;
  cancel(workspaceId: string): void;
  clearAll(): void;
  markRecentlyRefreshed(workspaceId: string): void;
  readonly size: number;
}

interface StatusCoalescerEntry {
  runFn: StatusRunFn;
  running: boolean;
  followUpRequested: boolean;
}

interface StatusCoalescerOptions {
  readonly delayMs: number;
  /**
   * How long after a `markRecentlyRefreshed()` call the coalescer ignores
   * incoming `schedule()` requests. Separated from `delayMs` (the trailing
   * debounce) because the watcher-feedback storm needs a longer dead-zone
   * than the responsive debounce window:
   *
   *   - `git status` itself can rewrite `.git/index` (racy index stat cache).
   *   - The Go agent debounces `.git` watcher events by 300 ms before
   *     emitting `git.changed`.
   *
   * So a status refresh produces a watcher event ~300–400 ms later. If the
   * suppression window equals the (typically 100 ms) debounce window, the
   * coalescer schedules another refresh, that refresh writes the index
   * again, and the loop never settles. Default suppression is 1 000 ms so
   * the feedback period is structurally broken without slowing genuine
   * external `git` activity by more than ~one second.
   *
   * A trigger inside the window is DEFERRED to the window's end rather than
   * dropped: dropping lost genuine changes outright (`git add` → refresh →
   * `git commit` 600 ms later → its event discarded → panel stuck on the
   * staged state until some unrelated event). The agent runs status with
   * GIT_OPTIONAL_LOCKS=0 so the index rewrite — and with it the feedback
   * event — normally doesn't happen at all; the deferral chain limit
   * covers gits that ignore that variable.
   */
  readonly suppressionMs?: number;
  readonly scheduler?: TimerScheduler;
  /** Injectable clock — defaults to Date.now. Overrideable in tests for
   *  deterministic suppression-window assertions without real time passage. */
  readonly nowFn?: () => number;
}

/**
 * Creates the debounce coordinator used by Git status refresh triggers.
 */
export function createStatusCoalescer({
  delayMs,
  suppressionMs,
  scheduler,
  nowFn = Date.now,
}: StatusCoalescerOptions): StatusCoalescer {
  const entries = new Map<string, StatusCoalescerEntry>();
  const timers: KeyedDebouncer<string> = createKeyedDebouncer<string>({ delayMs, scheduler });
  const timerScheduler = scheduler ?? defaultTimerScheduler;
  const lastRefreshedAt = new Map<string, number>();
  // At most one pending window-end run per workspace; a later trigger in the
  // same window just swaps in the newest runFn.
  const deferred = new Map<string, { handle: unknown; runFn: StatusRunFn }>();
  // Consecutive deferred runs since the last trigger that arrived outside a
  // suppression window.
  const deferredChain = new Map<string, number>();
  // Default to 1 s: longer than the Go-side `.git` watcher debounce (300 ms)
  // plus a safety margin, short enough that genuine external git activity
  // still feels responsive.
  const effectiveSuppressionMs = suppressionMs ?? Math.max(delayMs, 1_000);

  return {
    schedule(workspaceId, runFn) {
      const now = nowFn();
      const lastAt = lastRefreshedAt.get(workspaceId);
      if (lastAt !== undefined && now - lastAt < effectiveSuppressionMs) {
        deferPastWindow(workspaceId, runFn, lastAt + effectiveSuppressionMs - now);
        return;
      }
      deferredChain.delete(workspaceId);
      scheduleNow(workspaceId, runFn);
    },

    cancel(workspaceId) {
      timers.cancel(workspaceId);
      lastRefreshedAt.delete(workspaceId);
      clearDeferred(workspaceId);
      deferredChain.delete(workspaceId);
      const entry = entries.get(workspaceId);
      if (!entry) {
        return;
      }

      entry.followUpRequested = false;
      if (!entry.running) {
        entries.delete(workspaceId);
      }
    },

    clearAll() {
      timers.clearAll();
      lastRefreshedAt.clear();
      for (const workspaceId of [...deferred.keys()]) clearDeferred(workspaceId);
      deferredChain.clear();
      for (const [workspaceId, entry] of entries) {
        entry.followUpRequested = false;
        if (!entry.running) {
          entries.delete(workspaceId);
        }
      }
    },

    markRecentlyRefreshed(workspaceId) {
      lastRefreshedAt.set(workspaceId, nowFn());
    },

    get size() {
      return entries.size;
    },
  };

  /**
   * Debounced run (or follow-up request when one is already running) —
   * the normal path once a trigger is past any suppression window.
   */
  function scheduleNow(workspaceId: string, runFn: StatusRunFn): void {
    const entry = getOrCreateEntry(workspaceId, runFn);
    entry.runFn = runFn;

    if (entry.running) {
      entry.followUpRequested = true;
      timers.cancel(workspaceId);
      return;
    }

    timers.schedule(workspaceId, () => {
      const latestEntry = entries.get(workspaceId);
      if (!latestEntry) {
        return;
      }
      void runEntry(workspaceId, latestEntry);
    });
  }

  /**
   * Queue one run for when the suppression window ends. Past
   * DEFERRED_CHAIN_LIMIT back-to-back deferrals (a likely self-induced loop)
   * the wait backs off instead of dropping, so a genuine change is still
   * picked up — just later.
   */
  function deferPastWindow(workspaceId: string, runFn: StatusRunFn, waitMs: number): void {
    const pending = deferred.get(workspaceId);
    if (pending) {
      pending.runFn = runFn;
      return;
    }
    const chain = deferredChain.get(workspaceId) ?? 0;
    const delay = chain >= DEFERRED_CHAIN_LIMIT ? Math.max(waitMs, DEFERRED_BACKOFF_MS) : waitMs;
    const slot = { handle: null as unknown, runFn };
    slot.handle = timerScheduler.setTimeout(() => {
      if (deferred.get(workspaceId) !== slot) return;
      deferred.delete(workspaceId);
      deferredChain.set(workspaceId, chain + 1);
      scheduleNow(workspaceId, slot.runFn);
    }, delay);
    deferred.set(workspaceId, slot);
  }

  function clearDeferred(workspaceId: string): void {
    const pending = deferred.get(workspaceId);
    if (!pending) return;
    timerScheduler.clearTimeout(pending.handle);
    deferred.delete(workspaceId);
  }

  /**
   * Returns the current coalescing state for a workspace or creates it.
   */
  function getOrCreateEntry(workspaceId: string, runFn: StatusRunFn): StatusCoalescerEntry {
    const existing = entries.get(workspaceId);
    if (existing) {
      return existing;
    }

    const entry: StatusCoalescerEntry = {
      runFn,
      running: false,
      followUpRequested: false,
    };
    entries.set(workspaceId, entry);
    return entry;
  }

  /**
   * Executes one status refresh and optionally chains one dirty follow-up run.
   */
  async function runEntry(workspaceId: string, entry: StatusCoalescerEntry): Promise<void> {
    if (entry.running) {
      entry.followUpRequested = true;
      return;
    }

    entry.running = true;
    const runFn = entry.runFn;

    try {
      await runFn();
    } catch (error) {
      log.warn(`coalesced status refresh failed: ${(error as Error).message}`);
    } finally {
      entry.running = false;

      if (entry.followUpRequested) {
        entry.followUpRequested = false;
        void runEntry(workspaceId, entry);
      } else {
        entries.delete(workspaceId);
      }
    }
  }
}
