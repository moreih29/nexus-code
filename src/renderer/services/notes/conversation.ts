import { MAX_LINK_TITLE, type NoteLink, type NoteLinkTarget } from "../../../shared/notes/links";
import { type WorkspaceMeta, workspaceLocationKey } from "../../../shared/types/workspace";
import type { Tab } from "../../state/stores/tabs";
import type { AgentSession } from "../agent-sessions/model";
import type { ListedSession } from "../chat/sessions";

export type ConversationTab = Extract<Tab, { type: "claude" } | { type: "codex" }>;

interface ConversationStores {
  noteWorkspaceId: string;
  workspaces: readonly WorkspaceMeta[];
  tabsByWorkspace: Readonly<Record<string, Readonly<Record<string, Tab>>>>;
  history?: readonly ListedSession[];
}

export type ConversationResolution =
  | { kind: "open" | "moved"; workspace: WorkspaceMeta; tab: ConversationTab }
  | { kind: "resume"; workspace: WorkspaceMeta; session: ListedSession }
  | { kind: "missing" };

export function conversationTitle(savedTitle: string, target: ConversationResolution): string {
  if (target.kind === "open" || target.kind === "moved") return target.tab.title || savedTitle;
  if (target.kind === "resume") return savedTitle || target.session.title;
  return savedTitle;
}

/** Tasks use the location of the workspace that owns their notes. */
export function noteLocation(
  workspace: WorkspaceMeta,
  workspaces: readonly WorkspaceMeta[],
): string {
  const parent = workspace.task && workspaces.find((item) => item.id === workspace.task?.parentId);
  return workspaceLocationKey((parent || workspace).location);
}

export function tabLinkTarget(workspaceId: string, tab: ConversationTab): NoteLinkTarget {
  const session = tab.type === "claude" ? tab.props.sessionId : tab.props.threadId;
  return {
    workspaceId,
    tabId: tab.id,
    cwd: tab.props.cwd,
    title: tab.title.slice(0, MAX_LINK_TITLE),
    ...(tab.props.profileId ? { profileId: tab.props.profileId } : {}),
    ...(session ? { session } : {}),
  };
}

/** A replaced workspace can still resume a conversation if it has the same folder. */
export function historyWorkspace(
  link: NoteLink,
  stores: ConversationStores,
): WorkspaceMeta | undefined {
  const noteWorkspace = stores.workspaces.find((w) => w.id === stores.noteWorkspaceId);
  if (!noteWorkspace) return undefined;
  const location = noteLocation(noteWorkspace, stores.workspaces);
  const family = stores.workspaces.filter((w) => noteLocation(w, stores.workspaces) === location);
  return (
    family.find((w) => w.id === link.workspaceId) ?? family.find((w) => w.rootPath === link.cwd)
  );
}

export function resolveConversation(
  link: NoteLink,
  stores: ConversationStores,
): ConversationResolution {
  const workspace = stores.workspaces.find((w) => w.id === link.workspaceId);
  const direct = workspace && stores.tabsByWorkspace[workspace.id]?.[link.tabId];
  if (workspace && direct && direct.type === link.agent)
    return { kind: "open", workspace, tab: direct };

  const noteWorkspace = stores.workspaces.find((w) => w.id === stores.noteWorkspaceId);
  if (!noteWorkspace) return { kind: "missing" };
  const location = noteLocation(noteWorkspace, stores.workspaces);
  const family = stores.workspaces.filter((w) => noteLocation(w, stores.workspaces) === location);
  const ids = [...(link.session ? [link.session] : []), ...(link.sessions ?? [])];
  for (const session of ids) {
    for (const ws of family) {
      const tab = Object.values(stores.tabsByWorkspace[ws.id] ?? {}).find(
        (tab): tab is ConversationTab =>
          tab.type === link.agent &&
          (tab.type === "claude" ? tab.props.sessionId : tab.props.threadId) === session,
      );
      if (tab) return { kind: "moved", workspace: ws, tab };
    }
  }

  const resumeWorkspace = historyWorkspace(link, stores);
  if (resumeWorkspace) {
    for (const id of ids) {
      const session = stores.history?.find((item) => item.sessionId === id);
      if (session) return { kind: "resume", workspace: resumeWorkspace, session };
    }
  }
  return { kind: "missing" };
}

export type ConversationStatus =
  | "running"
  | "attention"
  | "failed"
  | "completed"
  | "seen"
  | "idle"
  | "limitWait"
  | "reported"
  | "closed"
  | "missing"
  | "checking";

export function conversationStatus(
  resolution: ConversationResolution,
  session: Pick<AgentSession, "state" | "hasTurns" | "limitWait"> | undefined,
  result: NoteLink["result"],
  checking = false,
): ConversationStatus {
  if (resolution.kind === "open" || resolution.kind === "moved") {
    if (session?.limitWait) return "limitWait";
    switch (session?.state) {
      case "running":
      case "busy":
        return "running";
      case "permissionPending":
      case "needsInput":
        return "attention";
      case "error":
        return "failed";
      case "completed":
        return "completed";
      default:
        return session?.hasTurns ? "seen" : "idle";
    }
  }
  if (result) return result.state === "done" ? "reported" : "failed";
  if (resolution.kind === "resume") return "closed";
  return checking ? "checking" : "missing";
}
