import { describe, expect, it } from "bun:test";
import { createAutoCheck } from "../../../../../src/main/features/updates/auto-check";
import type { TimerScheduler } from "../../../../../src/shared/util/timer-scheduler";

const HOUR = 60 * 60 * 1000;

/** A clock and timers moved by hand. */
function fakeTime() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const timer: TimerScheduler = {
    setTimeout: (run, delayMs) => {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, run });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  return {
    timer,
    now: () => now,
    /** Moves the clock on, running each timer due at its time. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        timers.delete(id);
        now = t.at;
        t.run();
      }
      now = until;
    },
    /** Moves the clock on without the timers, as sleep does. */
    sleep(ms: number) {
      now += ms;
      for (const t of timers.values()) t.at += ms;
    },
    pending: () => timers.size,
  };
}

function setup() {
  const time = fakeTime();
  let checks = 0;
  const auto = createAutoCheck({
    timer: time.timer,
    now: time.now,
    check: () => {
      checks++;
    },
    intervalMs: 4 * HOUR,
  });
  return { time, auto, checks: () => checks };
}

describe("createAutoCheck", () => {
  it("checks once started, then every interval", () => {
    const { time, auto, checks } = setup();
    auto.start();
    expect(checks()).toBe(1);

    time.advance(4 * HOUR - 1);
    expect(checks()).toBe(1);
    time.advance(1);
    expect(checks()).toBe(2);
    time.advance(8 * HOUR);
    expect(checks()).toBe(4);
    expect(time.pending()).toBe(1);
  });

  it("starts once", () => {
    const { time, auto, checks } = setup();
    auto.start();
    auto.start();
    expect(checks()).toBe(1);
    expect(time.pending()).toBe(1);
  });

  it("checks on waking only once an interval has passed since the last check", () => {
    const { time, auto, checks } = setup();
    auto.start();
    time.sleep(HOUR);
    auto.resume();
    expect(checks()).toBe(1);

    time.sleep(5 * HOUR);
    auto.resume();
    expect(checks()).toBe(2);
    // The next is an interval from that check, not from the timer slept through.
    time.advance(4 * HOUR - 1);
    expect(checks()).toBe(2);
    time.advance(1);
    expect(checks()).toBe(3);
    expect(time.pending()).toBe(1);
  });

  it("does not check on waking before it started", () => {
    const { time, auto, checks } = setup();
    time.sleep(10 * HOUR);
    auto.resume();
    expect(checks()).toBe(0);
  });

  it("checks now when asked, counting the next interval from then", () => {
    const { time, auto, checks } = setup();
    auto.start();
    time.advance(3 * HOUR);
    auto.checkNow();
    expect(checks()).toBe(2);
    time.advance(HOUR);
    expect(checks()).toBe(2);
    time.advance(3 * HOUR);
    expect(checks()).toBe(3);
  });
});
