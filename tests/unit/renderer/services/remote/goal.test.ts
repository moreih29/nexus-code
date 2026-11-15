import { describe, expect, test } from "bun:test";
import { goalSeconds } from "../../../../../src/renderer/services/chat/goal";
import { remoteGoalView } from "../../../../../src/renderer/services/remote/goal";

describe("another computer's chat's goal", () => {
  test("shows a Claude goal as the bar here does: since when, how many checks, ended once not active", () => {
    const goal = remoteGoalView(
      { condition: "All tests pass", status: "active", setAt: 1_000, checks: 2 },
      "claude",
    );
    expect(goal).toMatchObject({
      agent: "claude",
      objective: "All tests pass",
      status: "active",
      ended: false,
      setAt: 1_000,
      iterations: 2,
      checks: [],
    });
    expect(goalSeconds(goal, 61_000)).toBe(60);
    const met = remoteGoalView(
      { condition: "All tests pass", status: "met", setAt: 1_000, checks: 3, reason: "They do" },
      "claude",
    );
    expect(met).toMatchObject({ ended: true, status: "met", reason: "They do" });
    // The same goal, ended: closed, it stays closed.
    expect(met.key).toBe(goal.key);
  });

  test("a Codex goal pauses and goes on, and has no time to tell", () => {
    const paused = remoteGoalView({ condition: "Ship it", status: "paused", checks: 0 }, "codex");
    expect(paused).toMatchObject({ agent: "codex", status: "paused", ended: false });
    expect(paused).not.toHaveProperty("iterations");
    expect(goalSeconds(paused, 5_000, { running: true, startedAt: 1_000 })).toBeNull();
    expect(remoteGoalView({ condition: "Ship it", status: "met", checks: 0 }, "codex").ended).toBe(
      true,
    );
  });

  test("a status this version does not know reads as active", () => {
    expect(remoteGoalView({ condition: "x", status: "dreaming", checks: 0 }, "claude").status).toBe(
      "active",
    );
  });
});
