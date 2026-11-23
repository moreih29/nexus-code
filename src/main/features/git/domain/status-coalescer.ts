import { createLogger } from "../../../../shared/log/main";
import { createKeyedDebouncer, type KeyedDebouncer } from "../../../../shared/util/keyed-debouncer";
import {
  defaultTimerScheduler,
  type TimerScheduler,
} from "../../../../shared/util/timer-scheduler";

const log = createLogger("git");

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
  readonly suppressionMs?: number;
  readonly scheduler?: TimerScheduler;
  readonly nowFn?: () => number;
}

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
  const deferred = new Map<string, { handle: unknown; runFn: StatusRunFn }>();
  const deferredChain = new Map<string, number>();
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
