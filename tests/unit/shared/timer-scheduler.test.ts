import { describe, expect, test } from "bun:test";
import { defaultTimerScheduler } from "../../../src/shared/timer-scheduler";

describe("defaultTimerScheduler", () => {
  test("delegates setTimeout to global setTimeout", () => {
    let fired = false;
    const handle = defaultTimerScheduler.setTimeout(() => {
      fired = true;
    }, 0);
    expect(handle).toBeDefined();
    defaultTimerScheduler.clearTimeout(handle);
    expect(fired).toBe(false);
  });

  test("delegates clearTimeout to global clearTimeout", () => {
    let fired = false;
    const handle = defaultTimerScheduler.setTimeout(() => {
      fired = true;
    }, 10_000);
    defaultTimerScheduler.clearTimeout(handle);
    expect(fired).toBe(false);
  });
});
