/**
 * The title bar's inbox: the agent sessions of every workspace that wait on
 * the user. First those that need an answer, a permission or a look at an
 * error, which stay until the agent moves on; then those that finished a
 * turn the user has not looked at since. Pure: built from the same records
 * as the sessions tab.
 */

import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { type AgentSession, type SessionsInput, sessionsOf } from "./model";

export interface InboxInput extends SessionsInput {
  readonly workspaces: readonly WorkspaceMeta[];
  /** workspaceId → tabId → when the user last looked at the terminal. */
  readonly seenByWorkspace: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The terminal in front of the user, by session key, if any. */
  readonly viewing: string | null;
}

export interface InboxItem {
  readonly workspace: WorkspaceMeta;
  readonly session: AgentSession;
}

export interface Inbox {
  /** Those waiting on the user, then those done and not looked at. */
  readonly items: readonly InboxItem[];
  /** How many wait on the user. */
  readonly attention: number;
  /** How many are done and not looked at. */
  readonly unread: number;
}

/** A permission blocks the agent outright; an error, then a question, may not. */
const ATTENTION_RANK: Readonly<Record<string, number>> = {
  permissionPending: 0,
  error: 1,
  needsInput: 2,
};

/** Whether a session finished after the user last looked at its terminal. */
export function isUnread(session: AgentSession, seenAt: number | undefined): boolean {
  return seenAt === undefined || (session.since ?? 0) > seenAt;
}

export function buildInbox(input: InboxInput): Inbox {
  const attention: InboxItem[] = [];
  const done: InboxItem[] = [];
  for (const workspace of input.workspaces) {
    const seen = input.seenByWorkspace[workspace.id] ?? {};
    for (const session of sessionsOf(input, workspace)) {
      if (session.phase === "attention") {
        attention.push({ workspace, session });
      } else if (
        session.phase === "done" &&
        session.key !== input.viewing &&
        isUnread(session, seen[session.tabId])
      ) {
        done.push({ workspace, session });
      }
    }
  }
  attention.sort(
    (a, b) =>
      (ATTENTION_RANK[a.session.state] ?? 3) - (ATTENTION_RANK[b.session.state] ?? 3) ||
      longestWaitingFirst(a, b),
  );
  done.sort(longestWaitingFirst);
  return {
    items: [...attention, ...done],
    attention: attention.length,
    unread: done.length,
  };
}

function longestWaitingFirst(a: InboxItem, b: InboxItem): number {
  return (
    (a.session.since ?? 0) - (b.session.since ?? 0) || a.session.key.localeCompare(b.session.key)
  );
}

/**
 * The item to go to from the terminal `currentKey`: the one after it, so
 * going again steps through them all, or the first.
 */
export function nextInboxItem(
  items: readonly InboxItem[],
  currentKey: string | null,
): InboxItem | undefined {
  if (items.length === 0) return undefined;
  const at = items.findIndex((item) => item.session.key === currentKey);
  return items[(at + 1) % items.length];
}
