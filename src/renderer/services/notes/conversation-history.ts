import { type AgentProfiles, profilesOf } from "../../../shared/agent-profiles/profiles";
import { toSlashPath } from "../../../shared/fs/drive-path";
import type { NoteLink } from "../../../shared/notes/links";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { isWithinWorkspace, relPath } from "../../utils/path";
import type { ListedSession } from "../chat/sessions";
import { claudeSessions, codexThreads } from "../remote/history";

export type ConversationHistoryKey = readonly [
  agent: NoteLink["agent"],
  workspaceId: string,
  cwd: string,
  relativeCwd: string,
];

export function conversationHistoryKey(
  link: NoteLink,
  workspace: WorkspaceMeta | undefined,
): ConversationHistoryKey | undefined {
  if (!workspace || !(link.session || link.sessions?.length)) return undefined;
  const root = toSlashPath(workspace.rootPath).replace(/\/+$/, "") || "/";
  const cwd = toSlashPath(link.cwd);
  if (!isWithinWorkspace(cwd, root)) return undefined;
  // The directory is checked through the workspace's host (local, SSH or WSL).
  return [link.agent, workspace.id, link.cwd, relPath(cwd, root)];
}

export async function readConversationHistory(
  [agent, workspaceId, cwd, relativeCwd]: ConversationHistoryKey,
  config: AgentProfiles,
): Promise<ListedSession[]> {
  const dir = await ipcCallResult("fs", "stat", {
    workspaceId,
    relPath: relativeCwd,
    followSymlink: true,
  });
  if (!dir.ok || dir.value.type !== "dir") return [];
  const list = agent === "claude" ? claudeSessions : codexThreads;
  return list(
    workspaceId,
    cwd,
    profilesOf(config, agent).map((profile) => profile.id),
  );
}
