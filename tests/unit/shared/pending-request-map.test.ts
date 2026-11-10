import { describe, expect, test } from "bun:test";
import { PendingRequestMap } from "../../../src/shared/ipc/pending-request-map";
import type { TimerScheduler } from "../../../src/shared/util/timer-scheduler";

// ---------------------------------------------------------------------------
// Fake scheduler (same pattern as keyed-debouncer.test.ts)
// ---------------------------------------------------------------------------

function makeFakeScheduler(): TimerScheduler & {
  tick(): void;
  pendingCount: number;
} {
  type Entry = { callback: () => void; cancelled: boolean };
  const pending: Entry[] = [];

  return {
    setTimeout(callback) {
      const entry: Entry = { callback, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      (handle as Entry).cancelled = true;
    },
    tick() {
      const toRun = pending.splice(0);
      for (const entry of toRun) {
        if (!entry.cancelled) entry.callback();
      }
    },
    get pendingCount() {
      return pending.filter((e) => !e.cancelled).length;
    },
  };
}

describe("PendingRequestMap", () => {
  test("register returns a promise that resolves when resolve() is called", async () => {
    const map = new PendingRequestMap<string, number>();
    const promise = map.register({ key: "k1", timeoutMs: 5_000 });
    map.resolve("k1", 42);
    await expect(promise).resolves.toBe(42);
  });

  test("register returns a promise that rejects when reject() is called", async () => {
    const map = new PendingRequestMap<string, string>();
    const promise = map.register({ key: "k1", timeoutMs: 5_000 });
    map.reject("k1", new Error("boom"));
    await expect(promise).rejects.toThrow("boom");
  });

  test("register rejects with timeout error after timeoutMs", async () => {
    const scheduler = makeFakeScheduler();
    const map = new PendingRequestMap<string, number>(scheduler);
    const promise = map.register({ key: "k1", timeoutMs: 100 });

    // Timer has been scheduled but not yet fired.
    expect(scheduler.pendingCount).toBe(1);

    // Advance the fake clock — the timeout handler runs synchronously.
    scheduler.tick();

    await expect(promise).rejects.toThrow(/timed out/i);
  });

  test("onTimeout callback provides the rejection error on timeout", async () => {
    const scheduler = makeFakeScheduler();
    const map = new PendingRequestMap<string, number>(scheduler);
    const promise = map.register({
      key: "k1",
      timeoutMs: 100,
      onTimeout: () => new Error("custom timeout message"),
    });

    scheduler.tick();

    await expect(promise).rejects.toThrow("custom timeout message");
  });

  test("clearAll rejects all pending promises with the given reason", async () => {
    const map = new PendingRequestMap<string, number>();
    const p1 = map.register({ key: "k1", timeoutMs: 5_000 });
    const p2 = map.register({ key: "k2", timeoutMs: 5_000 });
    map.clearAll("shutting down");
    await expect(p1).rejects.toThrow("shutting down");
    await expect(p2).rejects.toThrow("shutting down");
    expect(map.size).toBe(0);
  });

  test("double resolve is a no-op (second call returns false)", async () => {
    const map = new PendingRequestMap<string, number>();
    const promise = map.register({ key: "k1", timeoutMs: 5_000 });
    map.resolve("k1", 10);
    const secondResult = map.resolve("k1", 99);
    expect(secondResult).toBe(false);
    await expect(promise).resolves.toBe(10);
  });
});
