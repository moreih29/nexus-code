import { useEffect, useState } from "react";
import { ipcCallResult } from "../../ipc/client";
import { EMPTY_TABS, useClaudeStatusStore } from "../../state/stores/claude-status";

export function useTerminalTwin(
  workspaceId: string,
  tabId: string,
  sessionId: string,
): string | null | undefined {
  const statuses = useClaudeStatusStore((s) => s.byWorkspace[workspaceId] ?? EMPTY_TABS);
  const [twin, setTwin] = useState<string | null>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a terminal's state changing is when to look again
  useEffect(() => {
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
