import { useMemo } from "react";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { type Tab, useTabsStore } from "../../state/stores/tabs";

export interface ListedSession {
  sessionId: string;
  title: string;
  firstPrompt?: string;
  gitBranch?: string;
  lastModified: number;
  size?: number;
  path?: string;
  profileId: string;
}

export function sessionMatches(
  session: Pick<ListedSession, "title" | "firstPrompt">,
  query: string | undefined,
): boolean {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${session.title}\n${session.firstPrompt ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

export async function withTranscriptSizes<T extends Pick<ListedSession, "path" | "size">>(
  workspaceId: string,
  sessions: readonly T[],
): Promise<T[]> {
  const paths = sessions.flatMap((s) => (s.path && s.size === undefined ? [s.path] : []));
  if (paths.length === 0) return [...sessions];
  const sizes = unwrapIpcResult(await ipcCallResult("chat", "fileSizes", { workspaceId, paths }));
  return sessions.map((s) => {
    const size = s.path ? sizes[s.path] : undefined;
    return size === undefined ? s : { ...s, size };
  });
}

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

export function useCodexThreadTabs(workspaceId: string, exceptTabId: string): Map<string, string> {
  const tabs = useTabsStore((s) => s.byWorkspace[workspaceId]);
  return useMemo(() => {
    const open = new Map<string, string>();
    for (const tab of Object.values(tabs ?? {})) {
      if (tab.type !== "codex" || tab.id === exceptTabId || !tab.props.threadId) continue;
      open.set(tab.props.threadId, tab.id);
    }
    return open;
  }, [tabs, exceptTabId]);
}
