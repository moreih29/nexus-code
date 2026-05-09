/**
 * Per-workspace status refresh coalescer. Bursty triggers use a trailing
 * debounce, while triggers received during an active run collapse into one
 * follow-up run after the active run settles.
 */
import { createKeyedDebouncer, type KeyedDebouncer } from "../../shared/keyed-debouncer";
import type { TimerScheduler } from "../../shared/timer-scheduler";

export type StatusRunFn = () => Promise<void> | void;

export interface StatusCoalescer {
  schedule(workspaceId: string, runFn: StatusRunFn): void;
  cancel(workspaceId: string): void;
  clearAll(): void;
  readonly size: number;
}

interface StatusCoalescerEntry {
  runFn: StatusRunFn;
  running: boolean;
  followUpRequested: boolean;
}

interface StatusCoalescerOptions {
  readonly delayMs: number;
  readonly scheduler?: TimerScheduler;
}

/**
 * Creates the debounce coordinator used by Git status refresh triggers.
 */
export function createStatusCoalescer({
  delayMs,
  scheduler,
}: StatusCoalescerOptions): StatusCoalescer {
  const entries = new Map<string, StatusCoalescerEntry>();
  const timers: KeyedDebouncer<string> = createKeyedDebouncer<string>({ delayMs, scheduler });

  return {
    schedule(workspaceId, runFn) {
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
      for (const [workspaceId, entry] of entries) {
        entry.followUpRequested = false;
        if (!entry.running) {
          entries.delete(workspaceId);
        }
      }
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
      console.warn("[git] coalesced status refresh failed", error);
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
