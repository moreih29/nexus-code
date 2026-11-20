import { describe, expect, mock, test } from "bun:test";
import {
  type DelaySampler,
  LOOP_CHECK_MS,
  startEventLoopMonitor,
} from "../../../src/main/infra/event-loop-monitor";

function setup() {
  const power = new Map<string, () => void>();
  let p99Ms = 25;
  let maxMs = 40;
  let t = 0;
  let tick: () => void = () => {};
  const sampler: DelaySampler = {
    enable: mock(),
    disable: mock(),
    reset: mock(),
    percentile: () => p99Ms * 1e6,
    get max() {
      return maxMs * 1e6;
    },
  };
  const warn = mock();
  const stop = startEventLoopMonitor(
    { error: mock(), warn, info: mock(), debug: mock() },
    {
      sampler,
      now: () => t,
      setInterval: (run) => {
        tick = run;
        return 1;
      },
      clearInterval: mock(),
      power: {
        on: (event, listener) => void power.set(event, listener),
        removeListener: (event) => void power.delete(event),
      },
    },
  );
  return {
    power,
    sampler,
    warn,
    stop,
    check(ms: number, p99: number, max: number) {
      t += ms;
      p99Ms = p99;
      maxMs = max;
      tick();
    },
  };
}

describe("event loop monitor", () => {
  test("below the limits writes nothing", () => {
    const m = setup();
    m.check(LOOP_CHECK_MS, 150, 900);
    m.check(LOOP_CHECK_MS, 200, 1000);
    expect(m.warn).not.toHaveBeenCalled();
    expect(m.sampler.reset).toHaveBeenCalledTimes(2);
  });

  test("p99 over 200 ms or a delay over 1 s writes one line", () => {
    const m = setup();
    m.check(LOOP_CHECK_MS, 250, 300);
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(String(m.warn.mock.calls[0]?.[0])).toBe(
      "main event loop was slow: p99=250ms max=300ms over 10s",
    );
    const m2 = setup();
    m2.check(LOOP_CHECK_MS, 30, 1500);
    expect(m2.warn).toHaveBeenCalledTimes(1);
  });

  test("checks in a row are limited to a line a minute, then counted", () => {
    const m = setup();
    for (let i = 0; i < 6; i++) m.check(LOOP_CHECK_MS, 500, 2000);
    expect(m.warn).toHaveBeenCalledTimes(1);
    m.check(LOOP_CHECK_MS, 500, 2000);
    expect(m.warn).toHaveBeenCalledTimes(2);
    expect(String(m.warn.mock.calls[1]?.[0])).toContain("(5 more)");
  });

  test("a check across a suspend or resume writes nothing, and only that one", () => {
    const m = setup();
    m.power.get("suspend")?.();
    m.power.get("resume")?.();
    m.check(LOOP_CHECK_MS * 10, 900, 60_000);
    expect(m.warn).not.toHaveBeenCalled();
    m.check(LOOP_CHECK_MS, 900, 60_000);
    expect(m.warn).toHaveBeenCalledTimes(1);
  });

  test("a check that came late without a sleep is a stall, its lateness the max", () => {
    const m = setup();
    m.check(LOOP_CHECK_MS + 40_000, 25, 40);
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(String(m.warn.mock.calls[0]?.[0])).toBe(
      "main event loop was slow: p99=25ms max=40000ms over 10s",
    );
  });

  test("stopping removes the power listeners", () => {
    const m = setup();
    m.stop();
    expect(m.power.size).toBe(0);
  });

  test("stopping disables the sampler", () => {
    const m = setup();
    m.stop();
    expect(m.sampler.disable).toHaveBeenCalledTimes(1);
  });
});
