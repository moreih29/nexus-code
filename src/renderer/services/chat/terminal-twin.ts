// Whether a Claude tab's session is also open in a terminal tab of the
// workspace: two processes on one session each write their own turns to
// it, and the conversation forks. The terminal's hooks tell its session
// id (claude.activity); a terminal's Claude state changing is the cue to
// look again, as when one starts or ends a session.

import { useEffect, useState } from "react";
import { ipcCallResult } from "../../ipc/client";
import { EMPTY_TABS, useClaudeStatusStore } from "../../state/stores/claude-status";

/** The terminal tab that runs `sessionId` too, or null. */
export function useTerminalTwin(
  workspaceId: string,
  tabId: string,
  sessionId: string | undefined,
): string | null {
  const statuses = useClaudeStatusStore((s) => s.byWorkspace[workspaceId] ?? EMPTY_TABS);
  const [twin, setTwin] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a terminal's state changing is when to look again
  useEffect(() => {
    if (!sessionId) {
      setTwin(null);
      return;
    }
    let live = true;
    ipcCallResult("claude", "activity", { workspaceIds: [workspaceId] })
      .then((result) => {
        if (!live || !result.ok) return;
        const other = result.value.find((s) => s.sessionId === sessionId && s.tabId !== tabId);
        setTwin(other?.tabId ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId, tabId, sessionId, statuses]);
  return twin;
}
