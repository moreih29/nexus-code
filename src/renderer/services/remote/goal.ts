import type { ViewGoal } from "../../../../packages/remote-protocol/src/view";
import type { GoalStatus, GoalView } from "../chat/goal";

const STATUSES: ReadonlySet<string> = new Set<GoalStatus>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "met",
  "failed",
]);

export function remoteGoalView(goal: ViewGoal, agent: "claude" | "codex"): GoalView {
  const status = (STATUSES.has(goal.status) ? goal.status : "active") as GoalStatus;
  return {
    agent,
    objective: goal.condition,
    status,
    key: `${agent}|${goal.setAt ?? ""}|${goal.condition}`,
    ended: agent === "claude" ? status !== "active" : status === "met" || status === "failed",
    endedLive: false,
    ...(goal.setAt !== undefined ? { setAt: goal.setAt } : {}),
    checks: (goal.checkReasons ?? []).map((check) => ({
      ...(check.at !== undefined ? { at: check.at } : {}),
      reason: check.reason,
    })),
    ...(agent === "claude" && goal.iterations !== undefined
      ? { iterations: goal.iterations }
      : agent === "claude" && goal.checks > 0
        ? { iterations: goal.checks }
        : {}),
    ...(goal.reason ? { reason: goal.reason } : {}),
    ...(goal.usedSeconds !== undefined ? { usedSeconds: goal.usedSeconds } : {}),
    ...(goal.usedAt !== undefined ? { usedAt: goal.usedAt } : {}),
    ...(goal.tokens !== undefined ? { tokens: goal.tokens } : {}),
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    ...(goal.durationMs !== undefined ? { durationMs: goal.durationMs } : {}),
    ...(goal.endedAt !== undefined ? { endedAt: goal.endedAt } : {}),
  };
}
