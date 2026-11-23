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
    expect(met.key).toBe(goal.key);
  });

  test("from 0.13.0, an ended Claude goal's checks as Claude Code counts them, the last too", () => {
    const met = remoteGoalView(
      { condition: "Say ok", status: "met", checks: 0, iterations: 1, reason: "It did" },
      "claude",
    );
    expect(met.iterations).toBe(1);
    expect(
      remoteGoalView({ condition: "x", status: "met", checks: 0, iterations: 1 }, "codex"),
    ).not.toHaveProperty("iterations");
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

  test("from 0.11.0, what its checks said, a Codex goal's time and tokens, and how long it took", () => {
    const codex = remoteGoalView(
      {
        condition: "Ship it",
        status: "active",
        checks: 0,
        usedSeconds: 90,
        usedAt: 10_000,
        tokens: 5_000,
        tokenBudget: null,
      },
      "codex",
    );
    expect(codex).toMatchObject({
      usedSeconds: 90,
      usedAt: 10_000,
      tokens: 5_000,
      tokenBudget: null,
    });
    expect(goalSeconds(codex, 20_000)).toBe(90);
    const met = remoteGoalView(
      {
        condition: "All tests pass",
        status: "met",
        setAt: 1_000,
        checks: 1,
        checkReasons: [{ at: 2_000, reason: "one fails" }],
        durationMs: 30_000,
        endedAt: 31_000,
      },
      "claude",
    );
    expect(met.checks).toEqual([{ at: 2_000, reason: "one fails" }]);
    expect(goalSeconds(met, 99_000)).toBe(30);
  });

  test("a status this version does not know reads as active", () => {
    expect(remoteGoalView({ condition: "x", status: "dreaming", checks: 0 }, "claude").status).toBe(
      "active",
    );
  });
});
