import {
  ChevronDown,
  Ellipsis,
  FileDiff,
  MessageSquarePlus,
  Plus,
  SquareTerminal,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyTextViaIpc } from "@/utils/clipboard";
import type { RemoteSession, RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import type { AgentListView } from "../../../shared/agent-list/view";
import { DEFAULT_AGENT_LIST_VIEW } from "../../../shared/agent-list/view";
import { peerWorkspaceId } from "../../../shared/fs/peer-url";
import type { RoomPeer } from "../../../shared/remote/room";
import { chatAgentOf, DEFAULT_TASK_AGENT } from "../../../shared/sessions/task-agent";
import { type SessionTreeNode, treeSessions } from "../../services/agent-sessions/session-tree";
import { type RemoteResults, useRemoteResults } from "../../services/agent-view/remote-results";
import { remoteSessionTree } from "../../services/agent-view/remote-session-tree";
import { remoteDisplayName } from "../../services/remote/display-name";
import type { PeerGitFile } from "../../services/remote/peer-git-status";
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
import { ListNote, StatusSections } from "../agent-list/status-view";
import { TaskHeaderAction, TaskHeaderLine } from "../agent-list/task-row-line";
import { TaskSections, worktreeName } from "../agent-list/task-view";
import { ViewSwitch } from "../agent-list/view-switch";
import { RemoteNewMenu } from "../agent-view/remote-new-menu";
import {
  closePeerSession,
  newPeerChat,
  newPeerTerminal,
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
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { EmptyState } from "../ui/empty-state";
import { PromptDialog, type PromptRequest } from "../ui/prompt-dialog";
import { SearchInput } from "../ui/search-input";
import { peerTarget } from "./room";
import { showPeerWorkspaceSession } from "./session-placement";
import { PeerTaskInfo } from "./task-info";

type Listing = { workspaces: readonly RemoteWorkspace[]; sessions: readonly RemoteSession[] };

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

export function peerFamilyRoot(
  target: PeerWorkspaceTarget,
  family: Listing | undefined,
): RemoteWorkspace {
  const rootId = target.workspace.parentId ?? target.workspaceId;
  return family?.workspaces.find((workspace) => workspace.id === rootId) ?? target.workspace;
}

export function PeerSessionsPanel({
  target,
  peer,
  listing,
}: {
  target: PeerWorkspaceTarget;
  peer?: RoomPeer;
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
    const workspace = family?.workspaces.find(({ id }) => id === opened.workspaceId);
    if (!workspace) return;
    const next = peerTarget(target.accountKey, device, workspace);
    selectPeerWorkspace(next);
    usePeerWorkspaceStore.getState().setFilesMode(peerTargetId(next), "agents");
    showPeerWorkspaceSession(next, opened);
  };

  const showChanges = (workspace: RemoteWorkspace, file?: PeerGitFile) => {
    let at = id;
    if (workspace.id !== target.workspaceId) {
      const next = peerTarget(target.accountKey, device, workspace);
      selectPeerWorkspace(next);
      at = peerTargetId(next);
    }
    const store = usePeerWorkspaceStore.getState();
    store.setFilesMode(at, "git");
    if (file) store.openDiff(at, file, file.unstaged ? "unstaged" : "staged");
  };
  const rootWorkspace = peerFamilyRoot(target, family);

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
    const renderSession: RenderSession = (session, tree, compact = false) => {
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
          compact={compact}
          tree={
            compact
              ? tree
              : {
                  ...tree,
                  elsewhere:
                    tree.elsewhere ?? (workspace?.parentId !== undefined ? workspace : undefined),
                }
          }
          className="w-full"
          aria-current={
            (session.workspaceId === target.workspaceId && session.tabId === activeTabId) ||
            undefined
          }
          onOpenSession={open}
        />
      );
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
          <AgentRows
            agents={agentRunsOf(session.agents)}
            selectedId={undefined}
            className={compact ? "pr-2 pb-1 pl-6" : "pl-4"}
          />
        </>
      );
    };
    return view === "task" ? (
      <PeerTaskView
        device={device}
        peer={peer}
        list={list}
        query={query}
        renderSession={renderSession}
        onOpenSession={open}
        onShowChanges={showChanges}
      />
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
          {peer && <PeerNewChat peer={peer} workspace={rootWorkspace} onOpenSession={open} />}
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
  compact?: boolean,
) => ReactNode;

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
  return (
    <StatusSections
      searching={searching}
      empty={<ListNote>{searching ? t("agentList.list.no_match") : t("agentList.none")}</ListNote>}
      testId="peer-agent-list-status-view"
      sections={groups.map(({ group, rows }) => {
        const remoteRows = rows.flatMap((row) => (row.kind === "remote" ? [row] : []));
        return {
          group,
          count: remoteRows.length,
          folded: !searching && folds.has(group),
          onToggle: () => useUIStore.getState().toggleAgentListGroup(group),
          onMarkRead:
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
              : undefined,
          body: () =>
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
            )),
        };
      })}
    />
  );
}

function PeerTaskView({
  device,
  peer,
  list,
  query,
  renderSession,
  onOpenSession,
  onShowChanges,
}: {
  device: RoomPeer;
  peer?: RoomPeer;
  list: { workspaces: RemoteWorkspace[]; sessions: RemoteSession[] };
  query: string;
  renderSession: RenderSession;
  onOpenSession: (opened: RemoteTarget) => void;
  onShowChanges: (workspace: RemoteWorkspace, file?: PeerGitFile) => void;
}) {
  const unfolded = useUIStore((s) => s.agentListUnfoldedTasks);
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
  const shown = list.workspaces.filter(
    (workspace) =>
      !searching ||
      rootsOf.has(workspace.id) ||
      peerWorktreeName(workspace).toLowerCase().includes(needle),
  );
  return (
    <TaskSections
      testId="peer-agent-list-task-view"
      sections={shown.map((workspace) => {
        const here = rootsOf.get(workspace.id) ?? [];
        const foldId = peerWorkspaceId(device.id, workspace.id);
        const open = unfolded.has(foldId);
        return {
          key: workspace.id,
          name: peerWorktreeName(workspace),
          header: (
            <PeerTaskHeading
              workspace={workspace}
              peer={peer}
              unfolded={open}
              onToggle={() => useUIStore.getState().toggleAgentListTask(foldId)}
              onOpenSession={onOpenSession}
              onShowChanges={() => onShowChanges(workspace)}
            />
          ),
          info: open && (
            <PeerTaskInfo
              deviceId={device.id}
              workspace={workspace}
              canRead={peerServes(peer, "git")}
              onOpenFile={(file) => onShowChanges(workspace, file)}
              onShowChanges={() => onShowChanges(workspace)}
            />
          ),
          empty: here.length === 0,
          rows: here.map((root) => (
            <RemoteSessionBranch
              key={root.session.key}
              root={root}
              folded={familyFolds}
              searching={searching}
              workspaceOf={workspaceOf}
              renderRow={(node, tree) => {
                const session = byKey.get(node.session.key);
                return session ? (
                  <div className="border-t border-border">{renderSession(session, tree, true)}</div>
                ) : null;
              }}
            />
          )),
        };
      })}
    />
  );
}

function peerWorktreeName(workspace: RemoteWorkspace): string {
  return remoteDisplayName(
    worktreeName(workspace.name, workspace.parentId === undefined, workspace.git?.branch),
  );
}

function PeerTaskHeading({
  workspace,
  peer,
  unfolded,
  onToggle,
  onOpenSession,
  onShowChanges,
}: {
  workspace: RemoteWorkspace;
  peer?: RoomPeer;
  unfolded: boolean;
  onToggle: () => void;
  onOpenSession: (opened: RemoteTarget) => void;
  onShowChanges: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const branch = workspace.git?.branch;
  const where: PeerWorkspaceRef | undefined = peer && {
    deviceId: peer.id,
    deviceName: peer.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    path: workspace.path,
  };
  return (
    <TaskHeaderLine
      name={peerWorktreeName(workspace)}
      isRoot={workspace.parentId === undefined}
      branch={branch ? remoteDisplayName(branch) : undefined}
      changed={workspace.git?.uncommitted ?? 0}
      unfolded={unfolded}
      onToggle={onToggle}
      menuOpen={menuOpen}
      testId="peer-agent-list-task-header"
      actions={
        <>
          <TaskHeaderAction label={t("agentList.detail.show_changes")} onClick={onShowChanges}>
            <FileDiff aria-hidden className="size-3.5" />
          </TaskHeaderAction>
          {where && peerServes(peer, "terminal.control") && (
            <TaskHeaderAction
              label={t("agentList.task.open_terminal")}
              onClick={() => void newPeerTerminal(where, undefined, onOpenSession)}
            >
              <SquareTerminal aria-hidden className="size-3.5" />
            </TaskHeaderAction>
          )}
          {where && peerServes(peer, "chat.control") && (
            <TaskHeaderAction
              label={t("agentList.list.new_claude")}
              onClick={() => void newPeerChat(where, "claude", undefined, onOpenSession)}
            >
              <MessageSquarePlus aria-hidden className="size-3.5" />
            </TaskHeaderAction>
          )}
          <DropdownMenuRoot onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger>
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-6"
                tooltip={t("agentList.task.more")}
              >
                <Ellipsis aria-hidden className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void copyTextViaIpc(workspace.path)}>
                {t("agentList.task.copy_path")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        </>
      }
    />
  );
}

function PeerNewChat({
  peer,
  workspace,
  onOpenSession,
}: {
  peer: RoomPeer;
  workspace: RemoteWorkspace;
  onOpenSession: (opened: RemoteTarget) => void;
}) {
  const { t } = useTranslation();
  const agent = chatAgentOf(useTerminalStore((s) => s.taskAgent ?? DEFAULT_TASK_AGENT));
  if (!peerServes(peer, "chat.control")) return null;
  const where: PeerWorkspaceRef = {
    deviceId: peer.id,
    deviceName: peer.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    path: workspace.path,
  };
  const Icon = agent === "claude" ? ClaudeIcon : CodexIcon;
  const label = t(agent === "claude" ? "tabBar.new_claude" : "tabBar.new_codex");
  return (
    <div className="ml-auto flex">
      <Button
        size="icon-sm"
        className="w-auto gap-1 rounded-r-none px-2 @max-[200px]/agents:px-1.5"
        tooltip={label}
        onClick={() => void newPeerChat(where, agent, undefined, onOpenSession)}
        data-testid="peer-agent-list-new-chat"
        data-agent={agent}
      >
        <Plus aria-hidden className="size-3.5" />
        <Icon aria-hidden className="size-3.5 @max-[200px]/agents:hidden" />
      </Button>
      <RemoteNewMenu
        peer={peer}
        workspace={workspace}
        onOpenSession={onOpenSession}
        chatsOnly
        trigger={
          <Button
            size="icon-sm"
            className="w-6 rounded-l-none border-l border-primary-foreground/25"
            tooltip={t("agentList.list.new_chat")}
          >
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
        }
      />
    </div>
  );
}
