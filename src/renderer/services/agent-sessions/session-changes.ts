import type { CliSessionEvent, CliSessionGoal } from "../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { shownGoalOf } from "../chat/goal";
import { type AgentSession, type SessionsInput, sessionsOf } from "./model";

export interface SessionMark {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  readonly kind: AgentSession["kind"];
  readonly agent: string | undefined;
  readonly state: string;
  readonly phase: string;
  readonly message: string | undefined;
  readonly goal?: { readonly objective: string; readonly status: string };
}

export function markSessions(
  workspaces: readonly WorkspaceMeta[],
  input: SessionsInput,
): Map<string, SessionMark> {
  const marks = new Map<string, SessionMark>();
  for (const workspace of workspaces) {
    for (const session of sessionsOf(input, workspace)) {
      const chat = session.kind === "terminal" ? undefined : input.chats?.[session.key];
      const goal = chat ? shownGoalOf(chat) : null;
      const seen = input.seenByWorkspace?.[workspace.id]?.[session.tabId];
      const hasResult =
        session.state === "completed" ||
        (session.state === "quiet" &&
          input.activity.get(session.key)?.lastNotice?.at === session.since);
      const seenResult =
        hasResult && seen !== undefined && session.since !== undefined && session.since <= seen;
      marks.set(session.key, {
        workspaceId: session.workspaceId,
        tabId: session.tabId,
        title: session.title,
        kind: session.kind,
        agent: session.agent,
        state: seenResult ? "idle" : session.state,
        phase: session.phase,
        message: session.message,
        ...(goal ? { goal: { objective: goal.objective, status: goal.status } } : {}),
      });
    }
  }
  return marks;
}

function goalChange(was: SessionMark, mark: SessionMark): CliSessionGoal | undefined {
  const goal = mark.goal;
  if (!goal) return undefined;
  const before = was.goal && was.goal.objective === goal.objective ? was.goal.status : null;
  if (before === goal.status) return undefined;
  return { objective: goal.objective, from: before, status: goal.status };
}

export function sessionChanges(
  prev: ReadonlyMap<string, SessionMark>,
  next: ReadonlyMap<string, SessionMark>,
  at: number,
  seq: number,
): CliSessionEvent[] {
  const events: CliSessionEvent[] = [];
  const event = (
    mark: SessionMark,
    from: string | null,
    to: string,
    phase: string,
    goal?: CliSessionGoal,
  ) => {
    events.push({
      seq: seq + events.length,
      at,
      workspaceId: mark.workspaceId,
      tabId: mark.tabId,
      title: mark.title,
      kind: mark.kind,
      ...(mark.agent ? { agent: mark.agent } : {}),
      from,
      to,
      phase,
      ...(mark.message && to !== "closed" ? { message: mark.message } : {}),
      ...(goal ? { goal } : {}),
    });
  };
  for (const [key, mark] of next) {
    const was = prev.get(key);
    const goal = was ? goalChange(was, mark) : undefined;
    if (was?.state === mark.state && !goal) continue;
    if (was === undefined && mark.phase === "idle") continue;
    event(mark, was?.state ?? null, mark.state, mark.phase, goal);
  }
  for (const [key, mark] of prev) {
    if (!next.has(key)) event(mark, mark.state, "closed", "closed");
  }
  return events;
}
