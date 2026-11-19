import { useMemo } from "react";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { type Tab, useTabsStore } from "../../state/stores/tabs";

/** A session as a tab's list shows it: a Claude session, or a Codex thread. */
export interface ListedSession {
  sessionId: string;
  title: string;
  firstPrompt?: string;
  gitBranch?: string;
  /** Milliseconds since the epoch. */
  lastModified: number;
  /** Bytes its transcript takes, when known. */
  size?: number;
  /** Its transcript's path on the workspace's host, when the list gives it (a Codex thread's). */
  path?: string;
  /** The profile that keeps it. */
  profileId: string;
}

/** Whether a session's title or first prompt has every word of `query` (any case); any for none. */
export function sessionMatches(
  session: Pick<ListedSession, "title" | "firstPrompt">,
  query: string | undefined,
): boolean {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${session.title}\n${session.firstPrompt ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** The sessions with the sizes of their transcripts, where their paths are known. */
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

/** The workspace's Codex tabs by the thread each has open, but `exceptTabId`. */
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
