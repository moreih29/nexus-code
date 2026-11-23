import { useEffect } from "react";
import { create } from "zustand";
import { ipcCallResult } from "../../ipc/client";
import { EMPTY_TABS, useClaudeStatusStore } from "../../state/stores/claude-status";
import { registerWorkspaceCleanup } from "../../state/workspace-cleanup";

export interface ClaudeTabSession {
  tabId: string;
  sessionId: string;
}

interface ClaudeSessionsState {
  byWorkspace: Record<string, readonly ClaudeTabSession[]>;
}

export const useClaudeSessionsStore = create<ClaudeSessionsState>(() => ({ byWorkspace: {} }));

registerWorkspaceCleanup((workspaceId) => {
  if (!(workspaceId in useClaudeSessionsStore.getState().byWorkspace)) return;
  useClaudeSessionsStore.setState((s) => {
    const { [workspaceId]: _gone, ...rest } = s.byWorkspace;
    return { byWorkspace: rest };
  });
});

function sameSessions(a: readonly ClaudeTabSession[], b: readonly ClaudeTabSession[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.tabId === b[i]?.tabId && s.sessionId === b[i]?.sessionId)
  );
}

const asking = new Map<string, { again: boolean; done: Promise<void> }>();

export function refreshClaudeSessions(workspaceId: string): Promise<void> {
  const busy = asking.get(workspaceId);
  if (busy) {
    busy.again = true;
    return busy.done;
  }
  const entry = { again: false, done: Promise.resolve() };
  entry.done = (async () => {
    do {
      entry.again = false;
      const result = await ipcCallResult("claude", "activity", {
        workspaceIds: [workspaceId],
      }).catch(() => null);
      if (!result?.ok) continue;
      const sessions = result.value.flatMap((s) =>
        s.sessionId && s.workspaceId === workspaceId
          ? [{ tabId: s.tabId, sessionId: s.sessionId }]
          : [],
      );
      const was = useClaudeSessionsStore.getState().byWorkspace[workspaceId];
      if (was && sameSessions(was, sessions)) continue;
      useClaudeSessionsStore.setState((s) => ({
        byWorkspace: { ...s.byWorkspace, [workspaceId]: sessions },
      }));
    } while (entry.again);
    asking.delete(workspaceId);
  })();
  asking.set(workspaceId, entry);
  return entry.done;
}

export function twinOf(
  sessions: readonly ClaudeTabSession[],
  tabId: string,
  sessionId: string,
): string | null {
  return sessions.find((s) => s.sessionId === sessionId && s.tabId !== tabId)?.tabId ?? null;
}

export function followClaudeSessions(workspaceId: string): () => void {
  let was = useClaudeStatusStore.getState().byWorkspace[workspaceId];
  void refreshClaudeSessions(workspaceId);
  return useClaudeStatusStore.subscribe((s) => {
    const now = s.byWorkspace[workspaceId];
    if (now === was) return;
    was = now;
    void refreshClaudeSessions(workspaceId);
  });
}

export function useTerminalTwin(
  workspaceId: string,
  tabId: string,
  sessionId: string,
): string | null | undefined {
  const statuses = useClaudeStatusStore((s) => s.byWorkspace[workspaceId] ?? EMPTY_TABS);
  const sessions = useClaudeSessionsStore((s) => s.byWorkspace[workspaceId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a terminal's state changing is when to look again
  useEffect(() => {
    void refreshClaudeSessions(workspaceId);
  }, [workspaceId, statuses]);
  return sessions === undefined ? undefined : twinOf(sessions, tabId, sessionId);
}
