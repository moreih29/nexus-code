/**
 * Another computer's chat's goal, as its panel tells it (chat.watch's
 * `panel.goal`), in the shape this app's goal bar shows: what it is, where
 * it stands, since when, and how many checks found it unmet; from 0.11.0,
 * what the checks said, a Codex goal's time and tokens, and once it ended,
 * how long it took.
 */

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
    // A Claude goal ends once it is not active; a Codex goal pauses and goes on.
    ended: agent === "claude" ? status !== "active" : status === "met" || status === "failed",
    endedLive: false,
    ...(goal.setAt !== undefined ? { setAt: goal.setAt } : {}),
    checks: (goal.checkReasons ?? []).map((check) => ({
      ...(check.at !== undefined ? { at: check.at } : {}),
      reason: check.reason,
    })),
    ...(agent === "claude" && goal.checks > 0 ? { iterations: goal.checks } : {}),
    ...(goal.reason ? { reason: goal.reason } : {}),
    ...(goal.usedSeconds !== undefined ? { usedSeconds: goal.usedSeconds } : {}),
    ...(goal.usedAt !== undefined ? { usedAt: goal.usedAt } : {}),
    ...(goal.tokens !== undefined ? { tokens: goal.tokens } : {}),
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    ...(goal.durationMs !== undefined ? { durationMs: goal.durationMs } : {}),
    ...(goal.endedAt !== undefined ? { endedAt: goal.endedAt } : {}),
  };
}
