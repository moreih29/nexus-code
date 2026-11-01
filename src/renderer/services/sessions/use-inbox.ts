/**
 * The title bar's inbox kept current, and what it does for the user: go to
 * a session or the next one waiting on them, and mark the done ones read.
 */

import { useEffect, useState } from "react";
import { createLogger } from "../../../shared/log/renderer";
import type { TabActivity } from "../../../shared/sessions/agent-state";
import { ipcCallResult } from "../../ipc/client";
import { computeActiveContext } from "../../state/claude-active-context-sync";
import { useActiveStore } from "../../state/stores/active";
import { useAppFocusStore } from "../../state/stores/app-focus";
import { useClaudeStatusStore } from "../../state/stores/claude-status";
import { useLayoutStore } from "../../state/stores/layout/store";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { requestTabFocus } from "../tab-focus";
import { showTerminal } from "./actions";
import { buildInbox, type Inbox, type InboxItem, nextInboxItem, sameInbox } from "./inbox";
import { type AgentSession, activityByKey, sessionKey } from "./model";

const log = createLogger("inbox");

/**
 * How often Codex and other agents' output activity is read. Claude's state
 * is pushed; theirs only tells a finished turn, which can wait a moment.
 */
const INBOX_POLL_MS = 2_000;

/**
 * The terminal in front of the user, by session key: the active one, while
 * the app window has focus.
 */
export function viewingKey(): string | null {
  if (!useAppFocusStore.getState().focused) return null;
  const { workspaceId, tabId } = computeActiveContext();
  return workspaceId !== null && tabId !== null ? sessionKey(workspaceId, tabId) : null;
}

/** The inbox of every workspace as the stores and `activity` tell it now. */
function inboxNow(activity: ReadonlyMap<string, TabActivity>): Inbox {
  return buildInbox({
    workspaces: useWorkspacesStore.getState().workspaces,
    tabsByWorkspace: useTabsStore.getState().byWorkspace,
    claudeByWorkspace: useClaudeStatusStore.getState().byWorkspace,
    activity,
    now: Date.now(),
    seenByWorkspace: useSessionSeenStore.getState().byWorkspace,
    viewing: viewingKey(),
  });
}

/**
 * The inbox of every workspace, kept current: rebuilt as the stores change
 * and as the clock and the activity poll move on. The button showing it is
 * always there, so a rebuild that lists the same keeps the inbox it had and
 * renders nothing.
 */
export function useInbox(): Inbox {
  const [inbox, setInbox] = useState(() => inboxNow(new Map()));
  useEffect(() => {
    let activity: ReadonlyMap<string, TabActivity> = new Map();
    let cancelled = false;
    const update = (): void => {
      const next = inboxNow(activity);
      setInbox((prev) => (sameInbox(prev, next) ? prev : next));
    };
    const poll = async (): Promise<void> => {
      const result = await ipcCallResult("cli", "activity", {});
      if (cancelled) return;
      if (result.ok) activity = activityByKey(result.value);
      update();
    };
    const stops = [
      useWorkspacesStore.subscribe(update),
      useTabsStore.subscribe(update),
      useClaudeStatusStore.subscribe(update),
      useSessionSeenStore.subscribe(update),
      useActiveStore.subscribe(update),
      useLayoutStore.subscribe(update),
      useAppFocusStore.subscribe(update),
    ];
    void poll();
    const timer = setInterval(() => void poll(), INBOX_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const stop of stops) stop();
    };
  }, []);
  return inbox;
}

/** The inbox as it is now, read once. */
async function readInbox(): Promise<Inbox> {
  const result = await ipcCallResult("cli", "activity", {});
  if (!result.ok) log.warn(`activity read failed: ${result.message}`);
  return inboxNow(activityByKey(result.ok ? result.value : []));
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
  const seen = useSessionSeenStore.getState();
  for (const { session } of items) {
    if (session.phase !== "done") continue;
    seen.markSeen(session.workspaceId, session.tabId);
    // Claude's own completed state, which its tab and the sidebar show.
    if (!session.estimated) {
      void ipcCallResult("claude", "markSeen", {
        workspaceId: session.workspaceId,
        tabId: session.tabId,
      });
    }
  }
}
