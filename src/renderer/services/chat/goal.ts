export interface GoalCheck {
  at?: number;
  reason: string;
}

export interface ClaudeGoal {
  condition: string;
  setAt?: number;
  status: "active" | "met" | "failed";
  checks: GoalCheck[];
  reason?: string;
  iterations?: number;
  durationMs?: number;
  tokens?: number;
  endedAt?: number;
  endedLive?: boolean;
}

export const CODEX_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
] as const;

export type CodexGoalStatus = (typeof CODEX_GOAL_STATUSES)[number];

export interface CodexGoal {
  objective: string;
  status: CodexGoalStatus;
  timeUsedSeconds: number;
  usedAt?: number;
  tokensUsed: number;
  tokenBudget: number | null;
  createdAt?: number;
  endedLive?: boolean;
}

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "met"
  | "failed";

export interface GoalView {
  agent: "claude" | "codex";
  objective: string;
  status: GoalStatus;
  key: string;
  ended: boolean;
  endedLive: boolean;
  setAt?: number;
  usedSeconds?: number;
  usedAt?: number;
  checks: GoalCheck[];
  tokens?: number;
  tokenBudget?: number | null;
  durationMs?: number;
  iterations?: number;
  reason?: string;
  endedAt?: number;
}

export function claudeGoalView(goal: ClaudeGoal): GoalView {
  return {
    agent: "claude",
    objective: goal.condition,
    status: goal.status,
    key: `claude|${goal.setAt ?? ""}|${goal.condition}`,
    ended: goal.status !== "active",
    endedLive: goal.endedLive === true,
    setAt: goal.setAt,
    checks: goal.checks,
    tokens: goal.tokens,
    durationMs: goal.durationMs,
    iterations: goal.iterations,
    reason: goal.reason,
    endedAt: goal.endedAt,
  };
}

export function codexGoalView(goal: CodexGoal): GoalView {
  return {
    agent: "codex",
    objective: goal.objective,
    status: goal.status === "complete" ? "met" : goal.status,
    key: `codex|${goal.createdAt ?? ""}|${goal.objective}`,
    ended: goal.status === "complete",
    endedLive: goal.endedLive === true,
    usedSeconds: goal.timeUsedSeconds,
    usedAt: goal.usedAt,
    checks: [],
    tokens: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
  };
}

export function goalViewOf(model: { goal?: ClaudeGoal | null; threadGoal?: CodexGoal | null }) {
  const view = model.threadGoal
    ? codexGoalView(model.threadGoal)
    : model.goal
      ? claudeGoalView(model.goal)
      : null;
  return view && (!view.ended || view.endedLive) ? view : null;
}

export function shownGoalOf(chat: { model: object; goalClosed?: string }): GoalView | null {
  const goal = goalViewOf(chat.model as Parameters<typeof goalViewOf>[0]);
  return goal && !(goal.ended && chat.goalClosed === goal.key) ? goal : null;
}

export function goalSeconds(
  goal: GoalView,
  now: number,
  turn?: { running: boolean; startedAt?: number },
): number | null {
  if (goal.ended && goal.durationMs !== undefined) return Math.floor(goal.durationMs / 1000);
  if (goal.agent === "claude") {
    if (goal.setAt === undefined) return null;
    return Math.max(0, Math.floor((now - goal.setAt) / 1000));
  }
  if (goal.usedSeconds === undefined) return null;
  const used = goal.usedSeconds;
  if (!turn?.running || goal.status !== "active") return used;
  const from = Math.max(goal.usedAt ?? 0, turn.startedAt ?? 0);
  return from > 0 ? used + Math.max(0, Math.floor((now - from) / 1000)) : used;
}

export function clockLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function firstLineOf(text: string): { line: string; more: number } {
  const lines = text.trim().split(/\r?\n/);
  return { line: lines[0] ?? "", more: lines.length - 1 };
}

export function goalFeedbackReason(text: string, condition: string): string | null {
  const head = "Stop hook feedback:";
  if (!text.startsWith(head)) return null;
  const tag = `[${condition}]: `;
  const at = text.indexOf(tag, head.length);
  if (at < 0) return null;
  return text.slice(at + tag.length).trim();
}
