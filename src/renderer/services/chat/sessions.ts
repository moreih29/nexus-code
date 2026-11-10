// The sessions Claude Code keeps of a Claude tab's folder (the agent's
// chat.sessions), for a new tab to go on with one; and the Claude and Codex
// tabs that have one open already, which a session is shown in rather than
// run twice.

import { useEffect, useMemo, useState } from "react";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import type { CallReturn } from "../../ipc/types";
import { type Tab, useTabsStore } from "../../state/stores/tabs";

const log = createLogger("chat-sessions");

export type ClaudeSession = CallReturn<"chat", "sessions">[number] & {
  /** The Claude profile whose folder keeps it. */
  profileId: string;
};

/** A session as a tab's list shows it: a Claude session, or a Codex thread. */
export interface ListedSession {
  sessionId: string;
  title: string;
  firstPrompt?: string;
  gitBranch?: string;
  /** Milliseconds since the epoch. */
  lastModified: number;
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

/**
 * The folder's sessions in each of the profiles' folders, newest first;
 * null until they are read, or when none could be.
 */
export function useClaudeSessions(
  workspaceId: string,
  cwd: string,
  enabled: boolean,
  profileIds: readonly string[],
): readonly ClaudeSession[] | null {
  const [sessions, setSessions] = useState<readonly ClaudeSession[] | null>(null);
  const key = profileIds.join("\n");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const ids = key.split("\n");
    void Promise.all(
      ids.map((profileId) =>
        ipcCallResult("chat", "sessions", { workspaceId, cwd, profileId })
          .then((result) => unwrapIpcResult(result).map((session) => ({ ...session, profileId })))
          .catch((err: Error) => {
            log.warn(`sessions of ${cwd} (${profileId}) not read: ${err.message}`);
            return null;
          }),
      ),
    ).then((lists) => {
      if (!live) return;
      if (lists.every((list) => list === null)) return;
      const seen = new Set<string>();
      const merged = lists
        .flatMap((list) => list ?? [])
        .sort((a, b) => b.lastModified - a.lastModified)
        .filter((session) => !seen.has(session.sessionId) && seen.add(session.sessionId));
      setSessions(merged);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, cwd, enabled, key]);
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
