/**
 * The title bar's inbox kept current, and what it does for the user: go to
 * a session or the next one waiting on them, and mark the done ones read.
 */

import { useSyncExternalStore } from "react";
import type { TabActivity } from "../../../shared/sessions/agent-state";
import { ipcCallResult } from "../../ipc/client";
import { useActiveStore } from "../../state/stores/active";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useAppFocusStore } from "../../state/stores/app-focus";
import { useClaudeStatusStore } from "../../state/stores/claude-status";
import { useLayoutStore } from "../../state/stores/layout/store";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import { subscribeTabActivity, useTabActivityStore } from "../../state/stores/tab-activity";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { shownGoalOf } from "../chat/goal";
import { type ChatTabState, useChatStore } from "../chat/store";
import { requestTabFocus } from "../tab-focus";
import { showTerminal } from "./actions";
import { readTabActivity } from "./activity-poll";
import {
  buildInbox,
  type Inbox,
  type InboxInput,
  type InboxItem,
  nextInboxItem,
  sameInbox,
} from "./inbox";
import type { AgentSession } from "./model";
import { viewingKey } from "./viewing";

/** Every workspace's sessions' records as the stores and `activity` tell them now. */
export function sessionsInputNow(activity: ReadonlyMap<string, TabActivity>): InboxInput {
  return {
    workspaces: useWorkspacesStore.getState().workspaces,
    tabsByWorkspace: useTabsStore.getState().byWorkspace,
    claudeByWorkspace: useClaudeStatusStore.getState().byWorkspace,
    activity,
    now: Date.now(),
    seenByWorkspace: useSessionSeenStore.getState().byWorkspace,
    chats: useChatStore.getState().tabs,
    viewing: viewingKey(),
  };
}

/** The chat fields read by the inbox and the session change log. */
function sameChatSession(a: ChatTabState | undefined, b: ChatTabState): boolean {
  if (a === b) return true;
  if (
    !a ||
    a.phase !== b.phase ||
    a.model.running !== b.model.running ||
    a.model.turn?.startedAt !== b.model.turn?.startedAt ||
    a.model.items !== b.model.items ||
    a.model.permissions !== b.model.permissions ||
    a.model.lastResult !== b.model.lastResult
  ) {
    return false;
  }
  const before = shownGoalOf(a);
  const after = shownGoalOf(b);
  return before?.objective === after?.objective && before?.status === after?.status;
}

function subscribeChatSessions(listener: () => void): () => void {
  return useChatStore.subscribe(({ tabs }, { tabs: previous }) => {
    const keys = Object.keys(tabs);
    if (
      keys.length !== Object.keys(previous).length ||
      keys.some((key) => !sameChatSession(previous[key], tabs[key]))
    ) {
      listener();
    }
  });
}

/** The stores a session's state is read from: a change to any may change one. */
export const SESSION_STORES: readonly { subscribe(listener: () => void): () => void }[] = [
  useWorkspacesStore,
  useTabsStore,
  useClaudeStatusStore,
  useSessionSeenStore,
  { subscribe: subscribeChatSessions },
  useActiveStore,
  useLayoutStore,
  useAgentViewStore,
  useAppFocusStore,
  { subscribe: subscribeTabActivity },
];

/** The inbox of every workspace as the stores and `activity` tell it now. */
export function inboxNow(
  activity: ReadonlyMap<string, TabActivity> = useTabActivityStore.getState().activity,
): Inbox {
  return buildInbox(sessionsInputNow(activity));
}

const INBOX_UPDATE_MS = 175;
const inboxListeners = new Set<() => void>();
let inboxSnapshot: Inbox | undefined;
let inboxTimer: ReturnType<typeof setTimeout> | undefined;
let stopInboxSources: (() => void)[] = [];

function getInboxSnapshot(): Inbox {
  inboxSnapshot ??= inboxNow();
  return inboxSnapshot;
}

function updateInbox(): void {
  const next = inboxNow();
  if (inboxSnapshot && sameInbox(inboxSnapshot, next)) return;
  inboxSnapshot = next;
  for (const listener of inboxListeners) listener();
}

function scheduleInboxUpdate(): void {
  if (inboxTimer !== undefined) return;
  inboxTimer = setTimeout(() => {
    inboxTimer = undefined;
    updateInbox();
  }, INBOX_UPDATE_MS);
}

function subscribeInbox(listener: () => void): () => void {
  inboxListeners.add(listener);
  if (inboxListeners.size === 1) {
    stopInboxSources = SESSION_STORES.map((store) => store.subscribe(scheduleInboxUpdate));
    updateInbox();
  }
  return () => {
    inboxListeners.delete(listener);
    if (inboxListeners.size !== 0) return;
    for (const stop of stopInboxSources) stop();
    stopInboxSources = [];
    clearTimeout(inboxTimer);
    inboxTimer = undefined;
    inboxSnapshot = undefined;
  };
}

/** The shared inbox snapshot for the title bar and view switcher. */
export function useInbox(): Inbox {
  return useSyncExternalStore(subscribeInbox, getInboxSnapshot);
}

/** The inbox as it is now, its activity read afresh. */
async function readInbox(): Promise<Inbox> {
  await readTabActivity();
  return inboxNow(useTabActivityStore.getState().activity);
}

/** Shows the session's terminal with the keyboard in it, to answer it. */
export function goToSession(session: AgentSession): void {
  showTerminal(session);
  requestTabFocus(session.tabId);
}

/**
 * Shows the terminal of the session after the one in front of the user, or
 * of the first; going again steps through every one waiting.
 */
export async function goToNextWaiting(): Promise<void> {
  const next = nextInboxItem((await readInbox()).items, viewingKey());
  if (next) goToSession(next.session);
}

/** Marks the done sessions of `items` read; those waiting on the user stay. */
export function markRead(items: readonly InboxItem[]): void {
  for (const { session } of items) {
    if (session.phase !== "done") continue;
    markSessionRead(session);
  }
}

export function markSessionRead(session: AgentSession, at?: number): void {
  const { workspaceId, tabId, kind, estimated } = session;
  useSessionSeenStore.getState().markSeen(workspaceId, tabId, at);
  if (estimated || kind === "codex") return;
  let completedAt = at;
  let resultAt: number | undefined;
  if (kind === "claude" && at !== undefined) {
    const broker = useClaudeStatusStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (broker?.status !== "completed" || session.since === undefined || session.since > at) return;
    completedAt = broker.since;
    resultAt = session.since;
  }
  void ipcCallResult("claude", "markSeen", {
    workspaceId,
    tabId,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(resultAt === undefined ? {} : { resultAt }),
  });
}
