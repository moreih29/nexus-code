import {
  MAX_LINK_TITLE,
  type NoteLink,
  type NoteLinkEntry,
  type NoteLinkTarget,
} from "../../../shared/notes/links";
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

interface ResolvedNoteLink {
  entry: NoteLinkEntry;
  target: ConversationResolution;
}

function openTarget(target: ConversationResolution) {
  return target.kind === "open" || target.kind === "moved" ? target : undefined;
}

function resolvedSession({ entry, target }: ResolvedNoteLink): string | undefined {
  if (target.kind === "resume") return target.session.sessionId;
  const tab = openTarget(target)?.tab;
  if (!tab) return entry.link.session;
  return tab.type === "claude" ? tab.props.sessionId : tab.props.threadId;
}

function sameConversation(a: ResolvedNoteLink, b: ResolvedNoteLink): boolean {
  const left = a.entry.link;
  const right = b.entry.link;
  if (left.agent !== right.agent) return false;
  const leftOpen = openTarget(a.target);
  const rightOpen = openTarget(b.target);
  if (leftOpen && rightOpen) {
    return leftOpen.workspace.id === rightOpen.workspace.id && leftOpen.tab.id === rightOpen.tab.id;
  }
  if (left.workspaceId === right.workspaceId && left.tabId === right.tabId) return true;
  const session = resolvedSession(a);
  return session !== undefined && session === resolvedSession(b);
}

function targetRank(target: ConversationResolution): number {
  if (openTarget(target)) return 2;
  return target.kind === "resume" ? 1 : 0;
}

/** Conversation lists share a chip while task and card widgets keep their own link IDs. */
export function latestConversations<Row extends ResolvedNoteLink>(rows: readonly Row[]) {
  // Prefer a target we can open. For equivalent targets, the newest link represents the group.
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .reverse()
    .sort(
      (a, b) =>
        targetRank(b.row.target) - targetRank(a.row.target) ||
        b.row.entry.link.updatedAt - a.row.entry.link.updatedAt ||
        b.row.entry.link.createdAt - a.row.entry.link.createdAt,
    );
  const groups: { row: Row; index: number; links: Row[]; result: NoteLink["result"] }[] = [];
  for (const { row, index } of candidates) {
    const result = row.entry.link.result;
    const group = groups.find(({ links }) => links.some((link) => sameConversation(link, row)));
    if (!group) {
      groups.push({ row, index, links: [row], result });
      continue;
    }
    group.links.push(row);
    group.index = Math.min(group.index, index);
    if (result && (!group.result || result.at > group.result.at)) group.result = result;
  }
  return groups
    .sort((a, b) => a.index - b.index)
    .map(({ row, index, result }) => ({ ...row, key: rows[index].entry.id, result }));
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
  { checking = false, hasStoredTurns = false, line = false } = {},
): ConversationStatus {
  const reported = result && (result.state === "done" ? "reported" : "failed");
  if (openTarget(resolution)) {
    const state = session?.state;
    const active =
      state === "running" || state === "busy"
        ? "running"
        : state === "permissionPending" || state === "needsInput"
          ? "attention"
          : undefined;
    if (line && reported) return active ?? reported;
    if (session?.limitWait) return "limitWait";
    if (active) return active;
    if (state === "error") return "failed";
    if (state === "completed") return "completed";
    if (session?.hasTurns || hasStoredTurns) return "seen";
    return checking ? "checking" : "idle";
  }
  if (reported) return reported;
  if (resolution.kind === "resume") return "closed";
  return checking ? "checking" : "missing";
}
