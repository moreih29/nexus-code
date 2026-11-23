import { type AgentProfiles, profilesOf } from "../../../shared/agent-profiles/profiles";
import type { CliPastSession } from "../../../shared/cli/ui";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { useTabsStore } from "../../state/stores/tabs";
import { CodexController } from "../chat/codex/controller";
import { readCodexHistoryCatalog } from "../chat/codex/history-catalog";
import { type ListedSession, sessionMatches } from "../chat/sessions";
import { UiRequestError } from "../cli/handler";

export const DEFAULT_HISTORY = 50;

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

const FIRST_PROMPT_CHARS = 300;

export function pastSessionsOf(
  listed: readonly ListedSession[],
  cwd: string,
  profileName: (profileId: string) => string,
  query?: string,
  limit = DEFAULT_HISTORY,
  openIn: (sessionId: string) => string | undefined = () => undefined,
): CliPastSession[] {
  return listed
    .filter((s) => sessionMatches(s, query))
    .slice(0, limit)
    .map((s) => {
      const firstPrompt = s.firstPrompt?.trim();
      const tabId = openIn(s.sessionId);
      return {
        sessionId: s.sessionId,
        title: s.title,
        at: s.lastModified,
        ...(s.size !== undefined ? { bytes: s.size } : {}),
        cwd,
        profile: profileName(s.profileId),
        ...(firstPrompt && firstPrompt !== s.title
          ? { firstPrompt: firstPrompt.slice(0, FIRST_PROMPT_CHARS) }
          : {}),
        ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
        ...(tabId ? { tabId } : {}),
      };
    });
}

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

export async function codexThreads(
  workspaceId: string,
  cwd: string,
  profileIds: readonly string[],
  current?: CodexController,
): Promise<ListedSession[]> {
  const listed = await readCodexProfiles(profileIds, (profileId) =>
    current?.profileId === profileId
      ? current.listThreads()
      : CodexController.catalog({ workspaceId, cwd, profileId }),
  );
  const own = current?.currentThread();
  return listed.filter((s) => s.sessionId !== own);
}

export function peerCodexThreads(
  workspace: WorkspaceMeta,
  config: AgentProfiles,
  connection: string | undefined,
  query?: string,
): Promise<ListedSession[]> {
  const { id: workspaceId, rootPath: cwd, location } = workspace;
  const fresh = !query?.trim();
  return readCodexProfiles(
    profilesOf(config, "codex").map((profile) => profile.id),
    (profileId) =>
      readCodexHistoryCatalog(
        { workspaceId, cwd, location, connection, config },
        profileId,
        fresh,
        () => CodexController.catalog({ workspaceId, cwd, profileId }),
      ),
  );
}

async function readCodexProfiles(
  profileIds: readonly string[],
  load: (profileId: string) => Promise<Omit<ListedSession, "profileId">[]>,
): Promise<ListedSession[]> {
  const lists = await Promise.all(
    profileIds.map(async (profileId) => {
      try {
        return (await load(profileId)).map((thread) => ({ ...thread, profileId }));
      } catch {
        return null;
      }
    }),
  );
  if (lists.every((list) => list === null)) {
    throw new UiRequestError("Codex threads could not be read there");
  }
  return mergedSessions(lists.map((list) => list ?? []));
}

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
