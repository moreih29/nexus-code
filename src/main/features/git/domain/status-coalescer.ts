/**
 * Per-workspace status refresh coalescer. Bursty triggers use a trailing
 * debounce, while triggers received during an active run collapse into one
 * follow-up run after the active run settles.
 */

import { createLogger } from "../../../../shared/log/main";
import { createKeyedDebouncer, type KeyedDebouncer } from "../../../../shared/util/keyed-debouncer";
import type { TimerScheduler } from "../../../../shared/util/timer-scheduler";

const log = createLogger("git");

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
   */
  readonly suppressionMs?: number;
  readonly scheduler?: TimerScheduler;
}

/**
 * Creates the debounce coordinator used by Git status refresh triggers.
 */
export function createStatusCoalescer({
  delayMs,
  suppressionMs,
  scheduler,
}: StatusCoalescerOptions): StatusCoalescer {
  const entries = new Map<string, StatusCoalescerEntry>();
  const timers: KeyedDebouncer<string> = createKeyedDebouncer<string>({ delayMs, scheduler });
  const lastRefreshedAt = new Map<string, number>();
  // Default to 1 s: longer than the Go-side `.git` watcher debounce (300 ms)
  // plus a safety margin, short enough that genuine external git activity
  // still feels responsive.
  const effectiveSuppressionMs = suppressionMs ?? Math.max(delayMs, 1_000);

  return {
    schedule(workspaceId, runFn) {
      const now = Date.now();
      const lastAt = lastRefreshedAt.get(workspaceId);
      if (lastAt !== undefined && now - lastAt < effectiveSuppressionMs) {
        return;
      }

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
    },

    cancel(workspaceId) {
      timers.cancel(workspaceId);
      lastRefreshedAt.delete(workspaceId);
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
      for (const [workspaceId, entry] of entries) {
        entry.followUpRequested = false;
        if (!entry.running) {
          entries.delete(workspaceId);
        }
      }
    },

    markRecentlyRefreshed(workspaceId) {
      lastRefreshedAt.set(workspaceId, Date.now());
    },

    get size() {
      return entries.size;
    },
  };

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
