/**
 * The conversations of the past in a workspace's folder, for another
 * device to go on with one (chat.history, chat.resume): Claude Code's
 * sessions as a Claude tab's list reads them, in each Claude profile's
 * folder, and the threads a Codex tab's own Codex lists. Codex keeps no
 * list the app can read without it, so a workspace with no Codex tab has
 * none to give.
 */

import type { CliPastSession } from "../../../shared/cli/ui";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { useTabsStore } from "../../state/stores/tabs";
import { agentTabController } from "../chat/agent-tab";
import { type ListedSession, sessionMatches } from "../chat/sessions";
import { UiRequestError } from "../cli/handler";

/** How many a list gives when it does not say. */
export const DEFAULT_HISTORY = 50;

/** Merged from each profile's list: newest first, each session once. */
export function mergedSessions(lists: readonly (readonly ListedSession[])[]): ListedSession[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .sort((a, b) => b.lastModified - a.lastModified)
    .filter((s) => {
      if (seen.has(s.sessionId)) return false;
      seen.add(s.sessionId);
      return true;
    });
}

/** The list as the protocol gives it: those that match, at most `limit`. */
export function pastSessionsOf(
  listed: readonly ListedSession[],
  cwd: string,
  profileName: (profileId: string) => string,
  query?: string,
  limit = DEFAULT_HISTORY,
): CliPastSession[] {
  return listed
    .filter((s) => sessionMatches(s, query))
    .slice(0, limit)
    .map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      at: s.lastModified,
      ...(s.size !== undefined ? { bytes: s.size } : {}),
      cwd,
      profile: profileName(s.profileId),
    }));
}

/** Claude Code's sessions of the folder, in each of the profiles' folders. */
export async function claudeSessions(
  workspaceId: string,
  cwd: string,
  profileIds: readonly string[],
): Promise<ListedSession[]> {
  const lists = await Promise.all(
    profileIds.map((profileId) =>
      ipcCallResult("chat", "sessions", { workspaceId, cwd, profileId })
        .then((result) => unwrapIpcResult(result).map((s) => ({ ...s, profileId })))
        .catch(() => null),
    ),
  );
  if (lists.every((list) => list === null)) {
    throw new UiRequestError("Claude Code's sessions could not be read there");
  }
  return mergedSessions(lists.map((list) => list ?? []));
}

/** The threads a Codex tab of the workspace lists, by the profile it runs with. */
export async function codexThreads(
  workspaceId: string,
  defaultProfileId: string,
): Promise<ListedSession[]> {
  const tab = Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {}).find(
    (t) => t.type === "codex",
  );
  const target = tab ? agentTabController(workspaceId, tab.id) : null;
  if (!tab || target?.agent !== "codex") {
    throw new UiRequestError(
      "Codex lists its threads only to a Codex chat: open one in that workspace (chat.new)",
    );
  }
  const profileId = (tab.type === "codex" && tab.props.profileId) || defaultProfileId;
  // The tab's own thread is left out of its list: it is open already.
  return (await target.controller.listThreads()).map((t) => ({ ...t, profileId }));
}

/** The tab that has the session open already; none when no tab does. */
export function tabWithSession(
  workspaceId: string,
  agent: ChatAgent,
  sessionId: string,
): string | undefined {
  return Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {}).find((tab) =>
    tab.type === "claude" && agent === "claude"
      ? tab.props.sessionId === sessionId
      : tab.type === "codex" && agent === "codex" && tab.props.threadId === sessionId,
  )?.id;
}
