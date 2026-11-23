import type { RpcParams } from "../../../../packages/remote-protocol/src/rpc";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { type AgentSession, type SessionsInput, sessionKey, sessionsOf } from "./model";

export interface InboxInput extends SessionsInput {
  readonly workspaces: readonly WorkspaceMeta[];
  readonly seenByWorkspace: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly viewing: string | null;
}

export interface InboxItem {
  readonly workspace: WorkspaceMeta;
  readonly session: AgentSession;
}

export interface Inbox {
  readonly items: readonly InboxItem[];
  readonly attention: number;
  readonly unread: number;
}

const ATTENTION_RANK: Readonly<Record<string, number>> = {
  permissionPending: 0,
  error: 1,
  needsInput: 2,
};

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

export function unreadResults(inbox: Inbox) {
  return inbox.items.flatMap(({ session }) => {
    const { since } = session;
    return session.phase === "done" &&
      !session.limitWait &&
      since !== undefined &&
      Number.isFinite(since)
      ? [{ session, since }]
      : [];
  });
}

export function acknowledgedResults(inbox: Inbox, seen: RpcParams<"sessions.markSeen">["seen"]) {
  const unread = new Map(unreadResults(inbox).map((result) => [result.session.key, result]));
  return seen.flatMap(({ workspaceId, tabId, upTo }) => {
    const key = sessionKey(workspaceId, tabId);
    const result = unread.get(key);
    if (!result || result.since > upTo || result.session.workspaceId !== workspaceId) return [];
    unread.delete(key);
    return [result];
  });
}

export function sameInbox(a: Inbox, b: Inbox): boolean {
  return (
    a.items.length === b.items.length &&
    a.items.every((item, i) => {
      const other = b.items[i];
      return (
        other !== undefined &&
        item.workspace === other.workspace &&
        sameFields(item.session, other.session)
      );
    })
  );
}

function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

function longestWaitingFirst(a: InboxItem, b: InboxItem): number {
  return (
    (a.session.since ?? 0) - (b.session.since ?? 0) || a.session.key.localeCompare(b.session.key)
  );
}

export function nextInboxItem(
  items: readonly InboxItem[],
  currentKey: string | null,
): InboxItem | undefined {
  if (items.length === 0) return undefined;
  const at = items.findIndex((item) => item.session.key === currentKey);
  return items[(at + 1) % items.length];
}
