/**
 * The title bar's inbox kept current, and what it does for the user: go to
 * a session or the next one waiting on them, and mark the done ones read.
 */

import { useEffect, useState } from "react";
import type { TabActivity } from "../../../shared/sessions/agent-state";
import { ipcCallResult } from "../../ipc/client";
import { useActiveStore } from "../../state/stores/active";
import { useAppFocusStore } from "../../state/stores/app-focus";
import { useClaudeStatusStore } from "../../state/stores/claude-status";
import { useLayoutStore } from "../../state/stores/layout/store";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import { useTabActivityStore } from "../../state/stores/tab-activity";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { useChatStore } from "../chat/store";
import { requestTabFocus } from "../tab-focus";
import { showTerminal } from "./actions";
import { readTabActivity } from "./activity-poll";
import { buildInbox, type Inbox, type InboxItem, nextInboxItem, sameInbox } from "./inbox";
import type { AgentSession } from "./model";
import { viewingKey } from "./viewing";


/** The inbox of every workspace as the stores and `activity` tell it now. */
function inboxNow(activity: ReadonlyMap<string, TabActivity>): Inbox {
  return buildInbox({
    workspaces: useWorkspacesStore.getState().workspaces,
    tabsByWorkspace: useTabsStore.getState().byWorkspace,
    claudeByWorkspace: useClaudeStatusStore.getState().byWorkspace,
    activity,
    now: Date.now(),
    seenByWorkspace: useSessionSeenStore.getState().byWorkspace,
    chats: useChatStore.getState().tabs,
    viewing: viewingKey(),
  });
}

/**
 * The inbox of every workspace, kept current: rebuilt as the stores change
 * and as the clock and the activity reads move on. The button showing it is
 * always there, so a rebuild that lists the same keeps the inbox it had and
 * renders nothing.
 */
export function useInbox(): Inbox {
  const [inbox, setInbox] = useState(() => inboxNow(useTabActivityStore.getState().activity));
  useEffect(() => {
    const update = (): void => {
      const next = inboxNow(useTabActivityStore.getState().activity);
      setInbox((prev) => (sameInbox(prev, next) ? prev : next));
    };
    const stops = [
      useWorkspacesStore.subscribe(update),
      useTabsStore.subscribe(update),
      useClaudeStatusStore.subscribe(update),
      useSessionSeenStore.subscribe(update),
      useChatStore.subscribe(update),
      useActiveStore.subscribe(update),
      useLayoutStore.subscribe(update),
      useAppFocusStore.subscribe(update),
      useTabActivityStore.subscribe(update),
    ];
    update();
    return () => {
      for (const stop of stops) stop();
    };
  }, []);
  return inbox;
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
  const seen = useSessionSeenStore.getState();
  for (const { session } of items) {
    if (session.phase !== "done") continue;
    seen.markSeen(session.workspaceId, session.tabId);
    // Claude's own completed state, which its tab and the sidebar show.
    if (!session.estimated && session.kind !== "codex") {
      void ipcCallResult("claude", "markSeen", {
        workspaceId: session.workspaceId,
        tabId: session.tabId,
      });
    }
  }
}
