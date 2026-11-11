// A conversation's goal (/goal): what the agent works toward, checking it
// each time it would stop, until it is met. The goal bar above the composer,
// the tab's badge and the agent view's row show it.
//
// Claude Code keeps it as a Stop hook (`/goal <condition>`): the stream tells
// it set ("Goal set: …", the command's output) and each check that found it
// unmet ("Stop hook feedback: [condition]: reason"); a met or failed check
// ends the turn, which only the session's transcript tells (goal_status).
// Codex keeps it on the thread and says each change (thread/goal/updated).

/** A check that found a Claude goal unmet. */
export interface GoalCheck {
  at?: number;
  reason: string;
}

/** A Claude tab's goal. */
export interface ClaudeGoal {
  condition: string;
  /** When it was set; unknown when the tab did not see it set. */
  setAt?: number;
  status: "active" | "met" | "failed";
  /** The checks that found it unmet, oldest first. */
  checks: GoalCheck[];
  /** Once it ended, as the last check told: why, after how many checks, how long, how many tokens. */
  reason?: string;
  iterations?: number;
  durationMs?: number;
  tokens?: number;
  endedAt?: number;
  /** It ended while the tab looked on: the bar says how until it is closed. */
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

/** A Codex thread's goal, as the server last told it. */
export interface CodexGoal {
  objective: string;
  status: CodexGoalStatus;
  /** The seconds Codex has worked toward it, as of `usedAt`. */
  timeUsedSeconds: number;
  usedAt?: number;
  tokensUsed: number;
  tokenBudget: number | null;
  createdAt?: number;
  /** It completed while the tab looked on. */
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

/** What the views show of either agent's goal. */
export interface GoalView {
  agent: "claude" | "codex";
  objective: string;
  status: GoalStatus;
  /** Tells this goal from the next one: an ended one closed stays closed. */
  key: string;
  ended: boolean;
  endedLive: boolean;
  /** Claude: counted from when it was set, as Claude Code counts. */
  setAt?: number;
  /** Codex: the time it worked, as of usedAt; it counts on while a turn runs. */
  usedSeconds?: number;
  usedAt?: number;
  checks: GoalCheck[];
  tokens?: number;
  tokenBudget?: number | null;
  /** Once ended: how long it took, the checks it took, and what the last one said. */
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

/**
 * The goal of a tab's model, as the views show it: none when it has none,
 * or when it ended before the tab looked on (the conversation tells that).
 */
export function goalViewOf(model: { goal?: ClaudeGoal | null; threadGoal?: CodexGoal | null }) {
  const view = model.threadGoal
    ? codexGoalView(model.threadGoal)
    : model.goal
      ? claudeGoalView(model.goal)
      : null;
  return view && (!view.ended || view.endedLive) ? view : null;
}

/**
 * The goal a tab shows: none once its bar was closed after it ended
 * (`goalClosed`, the closed goal's key).
 */
export function shownGoalOf(chat: { model: object; goalClosed?: string }): GoalView | null {
  const goal = goalViewOf(chat.model as Parameters<typeof goalViewOf>[0]);
  return goal && !(goal.ended && chat.goalClosed === goal.key) ? goal : null;
}

/**
 * The seconds a goal has taken at `now`: a Claude goal since it was set (as
 * Claude Code's own count), a Codex goal the time Codex worked toward it,
 * counting on while a turn runs. Null when it cannot be told.
 */
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
  const used = goal.usedSeconds ?? 0;
  if (!turn?.running || goal.status !== "active") return used;
  const from = Math.max(goal.usedAt ?? 0, turn.startedAt ?? 0);
  return from > 0 ? used + Math.max(0, Math.floor((now - from) / 1000)) : used;
}

/** 1:12:04, or 12:04 within the first hour. */
export function clockLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** The first line of a goal, and how many lines come after it. */
export function firstLineOf(text: string): { line: string; more: number } {
  const lines = text.trim().split(/\r?\n/);
  return { line: lines[0] ?? "", more: lines.length - 1 };
}

/**
 * The reason a "Stop hook feedback" message gives for the goal `condition`,
 * as Claude Code writes it (`Stop hook feedback:\n[condition]: reason`); null
 * when the message is another hook's.
 */
export function goalFeedbackReason(text: string, condition: string): string | null {
  const head = "Stop hook feedback:";
  if (!text.startsWith(head)) return null;
  const tag = `[${condition}]: `;
  const at = text.indexOf(tag, head.length);
  if (at < 0) return null;
  return text.slice(at + tag.length).trim();
}
