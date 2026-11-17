/**
 * What a list row says a session waits on and does, read by the row itself:
 * the lists took every conversation and drew each of their rows again with
 * each chunk of any reply streaming in. A row now renders when its own
 * facts change.
 */
import { useRef, useSyncExternalStore } from "react";
import type { SessionActivity } from "../../../shared/claude/activity";
import type { PermissionRequest } from "../chat/model";
import { chatKey, useChatStore } from "../chat/store";
import type { AgentSession } from "./model";
import { chatRowFacts, hookRowFacts, type RowFacts } from "./rows";

/** The facts of `session`'s row, from its conversation, or from its hooks (`activity`) for a terminal. */
export function useRowFacts(
  session: AgentSession,
  activity: SessionActivity | undefined,
): RowFacts {
  const key = session.kind === "terminal" ? null : chatKey(session.workspaceId, session.tabId);
  const kept = useRef<RowFacts | null>(null);
  const read = (): RowFacts => {
    const chat = key === null ? undefined : useChatStore.getState().tabs[key];
    const facts =
      key === null
        ? hookRowFacts(activity)
        : chat
          ? chatRowFacts(chat.model, activity)
          : hookRowFacts(undefined);
    // The same facts worked out again give the row the ones it has.
    if (kept.current && sameRowFacts(kept.current, facts)) return kept.current;
    kept.current = facts;
    return facts;
  };
  return useSyncExternalStore(key === null ? followNothing : useChatStore.subscribe, read);
}

/** The request the conversation of `session` waits on the user for first, if any. */
export function useFirstPermission(session: AgentSession): PermissionRequest | undefined {
  const key = chatKey(session.workspaceId, session.tabId);
  return useChatStore((s) =>
    session.kind === "terminal" ? undefined : s.tabs[key]?.model.permissions[0],
  );
}

/** Whether two rows' facts say the same, field by field. */
export function sameRowFacts(a: RowFacts, b: RowFacts): boolean {
  if (a === b) return true;
  return (
    sameFields(a.wait, b.wait) &&
    sameFields(a.tool, b.tool) &&
    sameFields(a.todos, b.todos) &&
    a.subagents === b.subagents &&
    a.context === b.context
  );
}

function sameFields(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  return keys.length === Object.keys(rb).length && keys.every((key) => ra[key] === rb[key]);
}

function followNothing(): () => void {
  return () => {};
}
