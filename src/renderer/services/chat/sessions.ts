// The sessions Claude Code keeps of a Claude tab's folder (the agent's
// chat.sessions), for a new tab to go on with one; and the Claude tabs that
// have one open already, which a session is shown in rather than run twice.

import { useEffect, useMemo, useState } from "react";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import type { CallReturn } from "../../ipc/types";
import { type Tab, useTabsStore } from "../../state/stores/tabs";

const log = createLogger("chat-sessions");

export type ClaudeSession = CallReturn<"chat", "sessions">[number];

/** The folder's sessions, newest first; null until they are read, or when they could not be. */
export function useClaudeSessions(
  workspaceId: string,
  cwd: string,
  enabled: boolean,
): readonly ClaudeSession[] | null {
  const [sessions, setSessions] = useState<readonly ClaudeSession[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    ipcCallResult("chat", "sessions", { workspaceId, cwd })
      .then((result) => {
        if (live) setSessions(unwrapIpcResult(result));
      })
      .catch((err: Error) => log.warn(`sessions of ${cwd} not read: ${err.message}`));
    return () => {
      live = false;
    };
  }, [workspaceId, cwd, enabled]);
  return sessions;
}

/** The workspace's Claude tabs by the session each has open, but `exceptTabId`. */
export function sessionTabs(
  tabs: Readonly<Record<string, Tab>> | undefined,
  exceptTabId: string,
): Map<string, string> {
  const open = new Map<string, string>();
  for (const tab of Object.values(tabs ?? {})) {
    if (tab.type !== "claude" || tab.id === exceptTabId || !tab.props.sessionId) continue;
    open.set(tab.props.sessionId, tab.id);
  }
  return open;
}

export function useSessionTabs(workspaceId: string, exceptTabId: string): Map<string, string> {
  const tabs = useTabsStore((s) => s.byWorkspace[workspaceId]);
  return useMemo(() => sessionTabs(tabs, exceptTabId), [tabs, exceptTabId]);
}
