/**
 * The sessions' state changes, told from two reads of every workspace's
 * sessions: one that appeared doing something, changed state, or whose tab
 * went. Pure; session-events.ts reads the stores and logs them.
 */

import type { CliSessionEvent } from "../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
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
}

/** Every workspace's sessions by key, as `input` tells them. */
export function markSessions(
  workspaces: readonly WorkspaceMeta[],
  input: SessionsInput,
): Map<string, SessionMark> {
  const marks = new Map<string, SessionMark>();
  for (const workspace of workspaces) {
    for (const session of sessionsOf(input, workspace)) {
      marks.set(session.key, {
        workspaceId: session.workspaceId,
        tabId: session.tabId,
        title: session.title,
        kind: session.kind,
        agent: session.agent,
        state: session.state,
        phase: session.phase,
        message: session.message,
      });
    }
  }
  return marks;
}

/**
 * The changes from `prev` to `next`, numbered from `seq`: a session whose
 * state is other than it was, or that appeared doing something, then those
 * that are gone. One appearing at rest (a tab opened, a workspace restored)
 * tells nothing yet.
 */
export function sessionChanges(
  prev: ReadonlyMap<string, SessionMark>,
  next: ReadonlyMap<string, SessionMark>,
  at: number,
  seq: number,
): CliSessionEvent[] {
  const events: CliSessionEvent[] = [];
  const event = (mark: SessionMark, from: string | null, to: string, phase: string) => {
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
    });
  };
  for (const [key, mark] of next) {
    const was = prev.get(key);
    if (was?.state === mark.state) continue;
    if (was === undefined && mark.phase === "idle") continue;
    event(mark, was?.state ?? null, mark.state, mark.phase);
  }
  for (const [key, mark] of prev) {
    if (!next.has(key)) event(mark, mark.state, "closed", "closed");
  }
  return events;
}
