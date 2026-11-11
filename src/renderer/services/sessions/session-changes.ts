/**
 * The sessions' state changes, told from two reads of every workspace's
 * sessions: one that appeared doing something, changed state, or whose tab
 * went. Pure; session-events.ts reads the stores and logs them.
 */

import type { CliSessionEvent, CliSessionGoal } from "../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { shownGoalOf } from "../chat/goal";
import { type AgentSession, type SessionsInput, sessionsOf } from "./model";

/** A session as a change is told from: what it is and how it stands. */
export interface SessionMark {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  readonly kind: AgentSession["kind"];
  readonly agent: string | undefined;
  readonly state: string;
  readonly phase: string;
  readonly message: string | undefined;
  /** A Claude or Codex tab's goal (/goal) while it shows one. */
  readonly goal?: { readonly objective: string; readonly status: string };
}

/** Every workspace's sessions by key, as `input` tells them. */
export function markSessions(
  workspaces: readonly WorkspaceMeta[],
  input: SessionsInput,
): Map<string, SessionMark> {
  const marks = new Map<string, SessionMark>();
  for (const workspace of workspaces) {
    for (const session of sessionsOf(input, workspace)) {
      const chat = session.kind === "terminal" ? undefined : input.chats?.[session.key];
      const goal = chat ? shownGoalOf(chat) : null;
      marks.set(session.key, {
        workspaceId: session.workspaceId,
        tabId: session.tabId,
        title: session.title,
        kind: session.kind,
        agent: session.agent,
        state: session.state,
        phase: session.phase,
        message: session.message,
        ...(goal ? { goal: { objective: goal.objective, status: goal.status } } : {}),
      });
    }
  }
  return marks;
}

/**
 * The goal's change from `was` to `mark`: a goal set, or its status changed.
 * A goal that goes (its bar closed, the conversation cleared) tells nothing.
 */
function goalChange(was: SessionMark, mark: SessionMark): CliSessionGoal | undefined {
  const goal = mark.goal;
  if (!goal) return undefined;
  const before = was.goal && was.goal.objective === goal.objective ? was.goal.status : null;
  if (before === goal.status) return undefined;
  return { objective: goal.objective, from: before, status: goal.status };
}

/**
 * The changes from `prev` to `next`, numbered from `seq`: a session whose
 * state is other than it was, or that appeared doing something, or whose
 * goal was set or changed, then those that are gone. One appearing at rest
 * (a tab opened, a workspace restored) tells nothing yet.
 */
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
