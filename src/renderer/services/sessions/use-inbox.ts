/**
 * The title bar's inbox kept current, and what it does for the user: go to
 * a session or the next one waiting on them, and mark the done ones read.
 */

import { useMemo } from "react";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { computeActiveContext } from "../../state/claude-active-context-sync";
import { useActiveStore } from "../../state/stores/active";
import { useClaudeStatusStore } from "../../state/stores/claude-status";
import { allLeaves } from "../../state/stores/layout/helpers";
import { useLayoutStore } from "../../state/stores/layout/store";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { requestTabFocus } from "../tab-focus";
import { showTerminal } from "./actions";
import { buildInbox, type Inbox, type InboxItem, nextInboxItem } from "./inbox";
import { type AgentSession, sessionKey } from "./model";
import { useNow, useTabActivity } from "./use-family";

const log = createLogger("inbox");

/**
 * How often Codex and other agents' output activity is read. Claude's state
 * is pushed; theirs only tells a finished turn, which can wait a moment.
 */
const INBOX_POLL_MS = 2_000;

/** The terminal in front of the user, by session key. */
function viewingKey(): string | null {
  const { workspaceId, tabId } = computeActiveContext();
  return workspaceId !== null && tabId !== null ? sessionKey(workspaceId, tabId) : null;
}

function useViewingKey(): string | null {
  const workspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const tabId = useLayoutStore((s) => {
    const layout = workspaceId ? s.byWorkspace[workspaceId] : undefined;
    if (!layout) return null;
    const leaf = allLeaves(layout.root).find((l) => l.id === layout.activeGroupId);
    return leaf?.activeTabId ?? null;
  });
  return workspaceId !== null && tabId !== null ? sessionKey(workspaceId, tabId) : null;
}

/** The inbox of every workspace, kept current. */
export function useInbox(): { inbox: Inbox; now: number } {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const tabsByWorkspace = useTabsStore((s) => s.byWorkspace);
  const claudeByWorkspace = useClaudeStatusStore((s) => s.byWorkspace);
  const seenByWorkspace = useSessionSeenStore((s) => s.byWorkspace);
  const viewing = useViewingKey();
  const activity = useTabActivity(true, INBOX_POLL_MS);
  const now = useNow(true, INBOX_POLL_MS);
  const inbox = useMemo(
    () =>
      buildInbox({
        workspaces,
        tabsByWorkspace,
        claudeByWorkspace,
        activity,
        now,
        seenByWorkspace,
        viewing,
      }),
    [workspaces, tabsByWorkspace, claudeByWorkspace, activity, now, seenByWorkspace, viewing],
  );
  return { inbox, now };
}

/** The inbox as it is now, read once. */
async function readInbox(): Promise<Inbox> {
  const result = await ipcCallResult("cli", "activity", {});
  if (!result.ok) log.warn(`activity read failed: ${result.message}`);
  const activity = new Map(
    (result.ok ? result.value : []).map((entry) => [
      sessionKey(entry.workspaceId, entry.tabId),
      entry,
    ]),
  );
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
