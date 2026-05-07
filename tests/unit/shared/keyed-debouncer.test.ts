import { describe, expect, test } from "bun:test";
import { createKeyedDebouncer } from "../../../src/shared/keyed-debouncer";
import type { TimerScheduler } from "../../../src/shared/timer-scheduler";

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

describe("createKeyedDebouncer", () => {
  test("schedule fires fn after delay via injected scheduler", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    const fired: string[] = [];
    debouncer.schedule("a", () => fired.push("a"));
    expect(fired).toEqual([]);
    scheduler.tick();
    expect(fired).toEqual(["a"]);
  });

  test("same-key reschedule cancels prior timer", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    const fired: string[] = [];
    debouncer.schedule("a", () => fired.push("first"));
    debouncer.schedule("a", () => fired.push("second"));
    scheduler.tick();
    expect(fired).toEqual(["second"]);
  });

  test("different keys do not interfere", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    const fired: string[] = [];
    debouncer.schedule("a", () => fired.push("a"));
    debouncer.schedule("b", () => fired.push("b"));
    scheduler.tick();
    expect(fired).toContain("a");
    expect(fired).toContain("b");
  });

  test("cancel prevents fn from firing", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    const fired: string[] = [];
    debouncer.schedule("a", () => fired.push("a"));
    debouncer.cancel("a");
    scheduler.tick();
    expect(fired).toEqual([]);
  });

  test("cancel on non-existent key is a no-op", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    expect(() => debouncer.cancel("ghost")).not.toThrow();
  });

  test("clearAll cancels all pending timers", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    const fired: string[] = [];
    debouncer.schedule("a", () => fired.push("a"));
    debouncer.schedule("b", () => fired.push("b"));
    debouncer.clearAll();
    scheduler.tick();
    expect(fired).toEqual([]);
    expect(debouncer.size).toBe(0);
  });

  test("size reflects current pending count", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    expect(debouncer.size).toBe(0);
    debouncer.schedule("a", () => {});
    expect(debouncer.size).toBe(1);
    debouncer.schedule("b", () => {});
    expect(debouncer.size).toBe(2);
    debouncer.cancel("a");
    expect(debouncer.size).toBe(1);
    scheduler.tick();
    expect(debouncer.size).toBe(0);
  });

  test("size decrements when timer fires", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    debouncer.schedule("a", () => {});
    expect(debouncer.size).toBe(1);
    scheduler.tick();
    expect(debouncer.size).toBe(0);
  });

  test("rescheduling same key does not increase size beyond 1", () => {
    const scheduler = makeFakeScheduler();
    const debouncer = createKeyedDebouncer<string>({ delayMs: 100, scheduler });
    debouncer.schedule("a", () => {});
    debouncer.schedule("a", () => {});
    debouncer.schedule("a", () => {});
    expect(debouncer.size).toBe(1);
  });
});
