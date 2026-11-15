/**
 * Another computer's chat's goal, as its panel tells it (chat.watch's
 * `panel.goal`), in the shape this app's goal bar shows: what it is, where
 * it stands, since when, and how many checks found it unmet. The checks'
 * reasons and a Codex goal's time and tokens stay on that computer.
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
    checks: [],
    ...(agent === "claude" && goal.checks > 0 ? { iterations: goal.checks } : {}),
    ...(goal.reason ? { reason: goal.reason } : {}),
  };
}
