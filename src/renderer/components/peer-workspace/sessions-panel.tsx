// The agent list of a workspace on another computer: the local list's
// header, views and group headings over what that computer tells. Its
// conversations and its tasks' are in it, by state or by task; a row opens
// its session in the workspace's tabs. Where that computer lets this one
// control its chats, the header starts a conversation there and a row's
// menu renames or closes it; nothing else is done from here (no tasks, no
// answers to permissions).

import { ChevronDown, FileDiff, Folder, GitBranch, Plus } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteSession, RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import type { AgentListView } from "../../../shared/agent-list/view";
import { DEFAULT_AGENT_LIST_VIEW } from "../../../shared/agent-list/view";
import type { RoomPeer } from "../../../shared/remote/room";
import { chatAgentOf, DEFAULT_TASK_AGENT } from "../../../shared/sessions/task-agent";
import { type SessionTreeNode, treeSessions } from "../../services/agent-sessions/session-tree";
import { type RemoteResults, useRemoteResults } from "../../services/agent-view/remote-results";
import { remoteSessionTree } from "../../services/agent-view/remote-session-tree";
import { remoteDisplayName } from "../../services/remote/display-name";
import { type PeerSessions, peerServes, peerSpeaks } from "../../services/remote/room";
import { selectPeerWorkspace } from "../../state/operations/workspace-selection";
import { useAgentListViewStore } from "../../state/stores/agent-list-view";
import { useAgentViewStore } from "../../state/stores/agent-view";
import {
  EMPTY_PEER_VIEW,
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import type { RemoteTarget } from "../../state/stores/remote-view";
import { useTerminalStore } from "../../state/stores/terminal";
import { useUIStore } from "../../state/stores/ui";
import { AgentRows } from "../agent-list/agent-rows";
import { StatusGroupHeading } from "../agent-list/status-view";
import { ViewSwitch } from "../agent-list/view-switch";
import { RemoteNewMenu } from "../agent-view/remote-new-menu";
import {
  closePeerSession,
  newPeerChat,
  type PeerSessionRef,
  type PeerWorkspaceRef,
  renamePeerSession,
} from "../agent-view/remote-session-actions";
import { RemoteSessionBranch } from "../agent-view/remote-session-branch";
import {
  agentRunsOf,
  FAILURE_SCHEMA,
  listedByDefault,
  OpenRemoteSessionRow,
  SessionMenu,
  statusGroups,
} from "../agent-view/remote-sessions";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { PromptDialog, type PromptRequest } from "../ui/prompt-dialog";
import { SearchInput } from "../ui/search-input";
import { peerTarget } from "./room";
import { showPeerWorkspaceSession } from "./session-placement";

type Listing = { workspaces: readonly RemoteWorkspace[]; sessions: readonly RemoteSession[] };

/**
 * The workspace's family as that computer lists it: the workspace its
 * tasks are of, then the tasks, with their sessions. Until it has listed
 * them all, the sessions of the workspace shown.
 */
export function peerFamilyListing(
  target: PeerWorkspaceTarget,
  listing: PeerSessions | undefined,
  shownSessions: readonly RemoteSession[] | undefined,
): Listing | undefined {
  if (listing?.status === "ready") {
    const rootId = target.workspace.parentId ?? target.workspaceId;
    const workspaces = listing.list.workspaces.filter(
      (workspace) => workspace.id === rootId || workspace.parentId === rootId,
    );
    if (workspaces.some((workspace) => workspace.id === target.workspaceId)) {
      const ids = new Set(workspaces.map((workspace) => workspace.id));
      return {
        workspaces,
        sessions: listing.list.sessions.filter((session) => ids.has(session.workspaceId)),
      };
    }
  }
  return shownSessions && { workspaces: [target.workspace], sessions: shownSessions };
}

export function PeerSessionsPanel({
  target,
  peer,
  listing,
}: {
  target: PeerWorkspaceTarget;
  peer?: RoomPeer;
  /** What that computer lists of its sessions, while it is watched. */
  listing?: PeerSessions;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const { sessions, tabs, activePath, agentListView } = usePeerWorkspaceStore(
    (s) => s.views[id] ?? EMPTY_PEER_VIEW,
  );
  const defaultView = useAgentListViewStore((s) => s.defaultView ?? DEFAULT_AGENT_LIST_VIEW);
  const view: AgentListView = agentListView ?? defaultView;
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<PeerSessionRef | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const selected = tabs.find((tab) => peerTabId(tab) === activePath);
  const activeTabId = selected?.type === "peer.session" ? selected.target.tabId : undefined;
  const device: RoomPeer = peer ?? {
    id: target.deviceId,
    name: target.deviceName,
    platform: target.platform,
    online: false,
  };
  const results = useRemoteResults(peer ? [peer] : [], true, target.accountKey);
  const family = peerFamilyListing(target, listing, sessions);
  const renameRequest = useMemo<PromptRequest | null>(
    () =>
      renaming && {
        title: t("tabBar.rename_tab"),
        defaultValue: renaming.title,
        confirmLabel: t("action.save"),
      },
    [renaming, t],
  );

  const open = (opened: RemoteTarget) => {
    if (opened.workspaceId === target.workspaceId) {
      showPeerWorkspaceSession(target, opened);
      return;
    }
    // Another worktree's: its workspace, with its list and the session open, as a local row does.
    const workspace = family?.workspaces.find(({ id }) => id === opened.workspaceId);
    if (!workspace) return;
    const next = peerTarget(target.accountKey, device, workspace);
    selectPeerWorkspace(next);
    usePeerWorkspaceStore.getState().setFilesMode(peerTargetId(next), "agents");
    showPeerWorkspaceSession(next, opened);
  };

  const body = (() => {
    if (!family) {
      return (
        <EmptyState
          title={
            device.online
              ? t("agentView.remote.loading")
              : t("agentView.remote.offline", { device: device.name })
          }
          tone="status"
        />
      );
    }
    const list = {
      workspaces: [...family.workspaces],
      sessions: family.sessions.map((session) =>
        results.session(
          device.id,
          session,
          peerSpeaks(device, FAILURE_SCHEMA),
          peerServes(device, "sessions.markSeen"),
        ),
      ),
    };
    const renderSession: RenderSession = (session, tree) => {
      const workspace = list.workspaces.find(({ id }) => id === session.workspaceId);
      const ref: PeerSessionRef = {
        deviceId: device.id,
        deviceName: remoteDisplayName(device.name),
        workspaceId: session.workspaceId,
        tabId: session.tabId,
        kind: session.kind,
        title: remoteDisplayName(session.title),
      };
      const row = (
        <OpenRemoteSessionRow
          session={session}
          peer={device}
          workspace={workspace}
          resultFeed={results}
          // A task's conversation tells its branch, as the local list's does.
          tree={{
            ...tree,
            elsewhere:
              tree.elsewhere ?? (workspace?.parentId !== undefined ? workspace : undefined),
          }}
          className="w-full"
          aria-current={
            (session.workspaceId === target.workspaceId && session.tabId === activeTabId) ||
            undefined
          }
          onOpenSession={open}
        />
      );
      // Renamed and closed as it is controlled: a chat with the chats, a terminal with the terminals.
      const controls = peerServes(
        device,
        session.kind === "terminal" ? "terminal.control" : "chat.control",
      );
      return (
        <>
          {controls ? (
            <SessionMenu
              onRename={() => setRenaming(ref)}
              onClose={() => void closePeerSession(ref)}
            >
              {row}
            </SessionMenu>
          ) : (
            row
          )}
          <AgentRows agents={agentRunsOf(session.agents)} selectedId={undefined} className="pl-4" />
        </>
      );
    };
    return view === "task" ? (
      <PeerTaskView device={device} list={list} query={query} renderSession={renderSession} />
    ) : (
      <PeerStatusView
        device={device}
        list={list}
        query={query}
        results={results}
        renderSession={renderSession}
      />
    );
  })();

  return (
    <div
      className="@container/agents flex min-h-0 flex-1 flex-col"
      data-testid="peer-agent-list-panel"
    >
      <div className="flex flex-col gap-2 border-b border-border/50 px-2 py-2">
        <SearchInput value={query} onChange={setQuery} label={t("agentList.list.search")} />
        <div className="flex items-center gap-1">
          <ViewSwitch
            view={view}
            onChange={(next) => usePeerWorkspaceStore.getState().setAgentListView(id, next)}
          />
          {peer && (
            <PeerNewChat
              peer={peer}
              target={target}
              onOpenSession={(opened) => showPeerWorkspaceSession(target, opened)}
            />
          )}
        </div>
      </div>
      <div className="app-scrollbar min-h-0 flex-1 overflow-auto">{body}</div>
      <PromptDialog
        request={renameRequest}
        busy={renameBusy}
        onCancel={() => setRenaming(null)}
        onConfirm={(title) => {
          if (!renaming) return;
          setRenameBusy(true);
          void renamePeerSession(renaming, title).then(() => {
            setRenameBusy(false);
            setRenaming(null);
          });
        }}
      />
    </div>
  );
}

type RenderSession = (
  session: RemoteSession,
  tree: Parameters<Parameters<typeof RemoteSessionBranch>[0]["renderRow"]>[1],
) => ReactNode;

/** By state, under the local list's group headings; the folds are the local list's. */
function PeerStatusView({
  device,
  list,
  query,
  results,
  renderSession,
}: {
  device: RoomPeer;
  list: { workspaces: RemoteWorkspace[]; sessions: RemoteSession[] };
  query: string;
  results: RemoteResults;
  renderSession: RenderSession;
}) {
  const { t } = useTranslation();
  const folds = useUIStore((s) => s.agentListFoldedGroups);
  const familyFolds = useAgentViewStore((s) => s.folded);
  const searching = query.trim() !== "";
  const { groups } = statusGroups([], [{ peer: device, list }], query, () => false);
  if (groups.every(({ rows }) => rows.length === 0)) {
    return (
      <p className="p-4 text-app-ui-sm text-muted-foreground">
        {searching ? t("agentList.list.no_match") : t("agentList.none")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-2" data-testid="peer-agent-list-status-view">
      {groups.map(({ group, rows }) => {
        const label = t(`agentList.group.${group}`);
        const remoteRows = rows.flatMap((row) => (row.kind === "remote" ? [row] : []));
        if (remoteRows.length === 0) {
          // A search tells only what it found.
          if (searching) return null;
          return (
            <section key={group} aria-label={label}>
              <StatusGroupHeading group={group} count={0} folded={false} />
            </section>
          );
        }
        // A search shows what it found, folded groups too.
        const folded = !searching && folds.has(group);
        return (
          <section key={group} aria-label={label} className="flex flex-col gap-1">
            <StatusGroupHeading
              group={group}
              count={remoteRows.length}
              folded={folded}
              onMarkRead={
                group === "done"
                  ? () =>
                      results.markSeen(
                        remoteRows.flatMap((row) =>
                          [...treeSessions([row.node])].flatMap((member) => {
                            const session = row.byKey.get(member.key);
                            return session
                              ? [
                                  {
                                    deviceId: device.id,
                                    session,
                                    hostReceipts: peerServes(device, "sessions.markSeen"),
                                  },
                                ]
                              : [];
                          }),
                        ),
                      )
                  : undefined
              }
            />
            {!folded &&
              remoteRows.map((row) => (
                <RemoteSessionBranch
                  key={row.node.session.key}
                  root={row.node}
                  folded={familyFolds}
                  searching={searching}
                  groupIdle
                  workspaceOf={(id) => row.workspaces.get(id)}
                  renderRow={(node, tree) => {
                    const session = row.byKey.get(node.session.key);
                    return session ? renderSession(session, tree) : null;
                  }}
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * By task: the workspace, then each of its tasks, headed by its name or
 * branch and its uncommitted changes, as the local list's task view.
 */
function PeerTaskView({
  device,
  list,
  query,
  renderSession,
}: {
  device: RoomPeer;
  list: { workspaces: RemoteWorkspace[]; sessions: RemoteSession[] };
  query: string;
  renderSession: RenderSession;
}) {
  const { t } = useTranslation();
  const familyFolds = useAgentViewStore((s) => s.folded);
  const needle = query.trim().toLowerCase();
  const searching = needle !== "";
  const { roots, byKey } = remoteSessionTree(
    device.id,
    list.sessions.filter(listedByDefault),
    query,
    list.sessions,
  );
  const rootsOf = new Map<string, SessionTreeNode[]>();
  for (const root of roots) {
    const at = root.session.workspaceId;
    rootsOf.set(at, [...(rootsOf.get(at) ?? []), root]);
  }
  const workspaceOf = (id: string) => list.workspaces.find((workspace) => workspace.id === id);
  // Empty worktrees can still be found by name.
  const shown = list.workspaces.filter(
    (workspace) =>
      !searching ||
      rootsOf.has(workspace.id) ||
      worktreeName(workspace).toLowerCase().includes(needle),
  );
  if (shown.length === 0) {
    return (
      <p className="p-4 text-app-ui-sm text-muted-foreground">{t("agentList.list.no_match")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-2" data-testid="peer-agent-list-task-view">
      {shown.map((workspace) => {
        const here = rootsOf.get(workspace.id) ?? [];
        return (
          <section
            key={workspace.id}
            aria-label={worktreeName(workspace)}
            className="overflow-hidden rounded-(--radius-raised) border border-border"
          >
            <PeerTaskHeading workspace={workspace} />
            {here.length === 0 && (
              <p className="border-t border-border px-3 py-1.5 text-app-ui-sm text-muted-foreground">
                {t("agentList.task.no_conversations")}
              </p>
            )}
            {here.map((root) => (
              <RemoteSessionBranch
                key={root.session.key}
                root={root}
                folded={familyFolds}
                searching={searching}
                workspaceOf={workspaceOf}
                renderRow={(node, tree) => {
                  const session = byKey.get(node.session.key);
                  return session ? (
                    <div className="border-t border-border px-1 py-1">
                      {renderSession(session, tree)}
                    </div>
                  ) : null;
                }}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** A worktree's name: the workspace's own, or a task's branch. */
function worktreeName(workspace: RemoteWorkspace): string {
  return remoteDisplayName(
    workspace.parentId === undefined ? workspace.name : (workspace.git?.branch ?? workspace.name),
  );
}

/** A worktree's heading: its mark and name, its branch, and its uncommitted changes. */
function PeerTaskHeading({ workspace }: { workspace: RemoteWorkspace }) {
  const { t } = useTranslation();
  const isRoot = workspace.parentId === undefined;
  const Icon = isRoot ? Folder : GitBranch;
  const name = worktreeName(workspace);
  const branch = isRoot ? workspace.git?.branch : null;
  const changed = workspace.git?.uncommitted ?? 0;
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-3 py-2 text-app-ui-sm"
      data-testid="peer-agent-list-task-header"
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className={
          branch ? "max-w-[70%] shrink-0 truncate font-medium" : "min-w-0 truncate font-medium"
        }
        title={name}
      >
        {name}
      </span>
      {branch && (
        <span
          className="flex min-w-0 shrink items-center gap-1 rounded-(--radius-control) bg-muted px-1.5 font-mono text-app-micro text-muted-foreground @max-xs/agents:hidden"
          title={branch}
        >
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{remoteDisplayName(branch)}</span>
        </span>
      )}
      {changed > 0 && (
        <span
          className="ml-auto flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums"
          title={t("agentList.detail.changes", { count: changed })}
        >
          <FileDiff aria-hidden className="size-3.5" />
          {changed}
        </span>
      )}
    </div>
  );
}

/**
 * A new conversation there, as the local list's: [+] with the default agent
 * (Settings' "Default agent"; Claude when that is a terminal), and the menu
 * of either agent with the profiles there. Only where that computer lets
 * this one control its chats.
 */
function PeerNewChat({
  peer,
  target,
  onOpenSession,
}: {
  peer: RoomPeer;
  target: PeerWorkspaceTarget;
  onOpenSession: (opened: RemoteTarget) => void;
}) {
  const { t } = useTranslation();
  const agent = chatAgentOf(useTerminalStore((s) => s.taskAgent ?? DEFAULT_TASK_AGENT));
  if (!peerServes(peer, "chat.control")) return null;
  const where: PeerWorkspaceRef = {
    deviceId: peer.id,
    deviceName: peer.name,
    workspaceId: target.workspace.id,
    workspaceName: target.workspace.name,
    path: target.workspace.path,
  };
  const Icon = agent === "claude" ? ClaudeIcon : CodexIcon;
  const label = t(agent === "claude" ? "tabBar.new_claude" : "tabBar.new_codex");
  return (
    <div className="ml-auto flex">
      <Button
        size="icon-sm"
        className="w-auto gap-1 rounded-r-none px-2 @max-[200px]/agents:px-1.5"
        title={label}
        aria-label={label}
        onClick={() => void newPeerChat(where, agent, undefined, onOpenSession)}
        data-testid="peer-agent-list-new-chat"
        data-agent={agent}
      >
        <Plus aria-hidden className="size-3.5" />
        <Icon aria-hidden className="size-3.5 @max-[200px]/agents:hidden" />
      </Button>
      <RemoteNewMenu
        peer={peer}
        workspace={target.workspace}
        onOpenSession={onOpenSession}
        chatsOnly
        trigger={
          <Button
            size="icon-sm"
            className="w-6 rounded-l-none border-l border-primary-foreground/25"
            aria-label={t("agentList.list.new_chat")}
            title={t("agentList.list.new_chat")}
          >
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
        }
      />
    </div>
  );
}
