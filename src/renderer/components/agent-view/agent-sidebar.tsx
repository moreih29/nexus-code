import { GitBranch, Plus } from "lucide-react";
import { type KeyboardEvent, memo, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStableHandlers } from "@/hooks/use-stable-handlers";
import type { ActivityByKey } from "@/services/agent-sessions/agents";
import type { InboxItem } from "@/services/agent-sessions/inbox";
import type { AgentSession, SessionFamily } from "@/services/agent-sessions/model";
import { compareStatusTime, type RowGroup } from "@/services/agent-sessions/rows";
import {
  type SessionCounts,
  type SessionTreeNode,
  searchSessionTree,
  sessionTree,
  treeSessions,
} from "@/services/agent-sessions/session-tree";
import { useSessionActivity } from "@/services/agent-sessions/use-family";
import { markRead } from "@/services/agent-sessions/use-inbox";
import { useRowFacts } from "@/services/agent-sessions/use-row-facts";
import { useSessionParent } from "@/services/agent-sessions/use-session-parent";
import { type Agents, workspaceColor } from "@/services/agent-view/agents";
import { parseSessionKey } from "@/services/agent-view/layout";
import { orderSessions, reorderSubset } from "@/services/agent-view/order";
import type { RemoteResults } from "@/services/agent-view/remote-results";
import { showInAgentView } from "@/services/agent-view/show";
import {
  moveSessionRoot,
  type SidebarWorktree,
  statusTrees,
  workspaceTrees,
} from "@/services/agent-view/sidebar-tree";
import { useAgents } from "@/services/agent-view/use-agents";
import { remoteDisplayName } from "@/services/remote/display-name";
import { peerServes } from "@/services/remote/room";
import { openClaudeTab, openCodexTab } from "@/state/operations/tabs";
import { type AgentListGrouping, useAgentViewStore } from "@/state/stores/agent-view";
import { useUIStore } from "@/state/stores/ui";
import { selectWorkspaceConnectionStatus, useWorkspacesStore } from "@/state/stores/workspaces";
import { cn } from "@/utils/cn";
import type { SessionActivity } from "../../../shared/claude/activity";
import { locationLabel, type WorkspaceMeta } from "../../../shared/types/workspace";
import { shortId } from "../../../shared/util/short-id";
import { AgentRows } from "../agent-list/agent-rows";
import { type RowPlace, rowShellClass, SessionRowLines } from "../agent-list/session-row";
import {
  HiddenSessionCount,
  SessionSign,
  stateLabel,
  useDurationLabel,
} from "../agent-list/session-status";
import {
  FamilyFold,
  FoldChevron,
  SessionTreeBranch,
  StateSummary,
  useParentCaption,
  visibleParentName,
} from "../agent-list/session-tree-rows";
import { AgentMark, StatusSections, useRowLine } from "../agent-list/status-view";
import { NewChatMenuItems } from "../agent-profiles/new-chat-menu";
import { GoalRowLine } from "../chat/goal-bar";
import { ContextMenuRoot, ContextMenuTrigger } from "../ui/context-menu";
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { IconButton } from "../ui/icon-button";
import { SearchInput } from "../ui/search-input";
import { useContextMenuHandoff } from "../ui/use-context-menu-handoff";
import { connectionStatusClassName } from "../workbench/sidebar";
import { SidebarResizeHandle } from "../workbench/sidebar-resize-handle";
import { SystemStatsFooter } from "../workbench/system-stats";
import { WorkspaceMenuContent } from "../workbench/workspace-menu";
import { WorkspaceNameInput } from "../workbench/workspace-name-input";
import { useWorkspaceRename, useWorkspaceUpdate } from "../workbench/workspace-rename";
import { PANEL_SHOWN_BG, PanelMark, panelPlaceOf } from "./panel-mark";
import { ConsentPages, PeerConsentCard, useConsentIsPending } from "./remote-consents";
import { RemoteSessionBranch } from "./remote-session-branch";
import {
  agentRunsOf,
  listedByDefault,
  OpenRemoteSessionRow,
  RemoteSessions,
  type RemoteStatusSource,
  type StatusRow,
  statusGroups,
} from "./remote-sessions";
import {
  endSessionDrag,
  hoverWorkspaceReorder,
  leaveWorkspaceReorder,
  type SessionReorder,
  startSessionDrag,
  useSessionDrop,
  useSessionReordering,
} from "./session-drop";
import { SidebarDropIndicator } from "./sidebar-drop";

const GROUPINGS: readonly AgentListGrouping[] = ["status", "workspace"];

export const AgentSidebar = memo(function AgentSidebar({ shown }: { shown: boolean }) {
  const { t } = useTranslation();
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const agents = useAgents();
  const grouping = useAgentViewStore((s) => s.grouping);
  const ids = useMemo(
    () => agents.families.flatMap((family) => family.worktrees.map((w) => w.workspace.id)),
    [agents],
  );
  const activity = useSessionActivity(ids, true);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  return (
    <aside className="relative flex shrink-0 flex-col" style={{ width: sidebarWidth }}>
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-(--radius-island) island-surface"
        data-testid="agent-sidebar"
      >
        <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-app-label text-muted-foreground uppercase">
              {t("agentView.list.title")}
            </span>
          </div>
          <fieldset
            aria-label={t("agentView.list.group_by")}
            className="flex flex-wrap items-center gap-1"
          >
            <span className="mr-0.5 text-app-micro whitespace-nowrap text-muted-foreground">
              {t("agentView.list.group_by")}
            </span>
            {GROUPINGS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={grouping === value}
                onClick={() => useAgentViewStore.getState().setGrouping(value)}
                className={cn(
                  "flex items-center rounded-full border px-2 py-0.5 text-app-micro whitespace-nowrap transition-colors",
                  grouping === value
                    ? "border-[var(--state-selected-indicator)] bg-[var(--sidebar-item-selected-bg)] text-foreground"
                    : "border-border text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
                )}
              >
                {t(`agentView.list.grouping.${value}`)}
              </button>
            ))}
          </fieldset>
          <SearchInput
            value={query}
            onChange={setQuery}
            label={t("agentList.list.search")}
            inputRef={searchRef}
            onKeyDown={(event) => fromSearch(event, listRef.current)}
            data-testid="agent-sidebar-search"
          />
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the keys come from the rows' own buttons */}
        <div
          ref={listRef}
          className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
          onKeyDown={(event) => stepRows(event, searchRef.current)}
        >
          {grouping === "workspace" &&
            (agents.families.length === 0 ? (
              <NoWorkspaces />
            ) : (
              <WorkspaceGroups agents={agents} activity={activity} query={query} />
            ))}
          <RemoteSessions
            query={query}
            shown={shown}
            renderStatus={
              grouping === "status"
                ? (remote, results) => (
                    <StatusGroups
                      agents={agents}
                      activity={activity}
                      query={query}
                      remote={remote}
                      results={results}
                    />
                  )
                : undefined
            }
          />
        </div>
        <SystemStatsFooter />
      </div>
      <SidebarResizeHandle />
    </aside>
  );
});

export function stepRows(event: KeyboardEvent<HTMLDivElement>, search: HTMLElement | null): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const here = event.target as HTMLElement;
  if (!here.matches("[data-agent-row]")) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-agent-row]")];
  const at = rows.indexOf(here);
  const next =
    event.key === "Home"
      ? rows[0]
      : event.key === "End"
        ? rows.at(-1)
        : rows[at + (event.key === "ArrowDown" ? 1 : -1)];
  const target = next ?? (at === 0 && event.key === "ArrowUp" ? search : null);
  if (!target) return;
  event.preventDefault();
  target.focus();
}

export function fromSearch(event: KeyboardEvent<HTMLInputElement>, list: HTMLElement | null): void {
  if (event.key !== "ArrowDown" && event.key !== "Enter") return;
  const first = list?.querySelector<HTMLElement>("[data-agent-row]");
  if (!first) return;
  if (event.key === "Enter") {
    if (event.currentTarget.value === "") return;
    event.preventDefault();
    first.click();
    return;
  }
  event.preventDefault();
  first.focus();
}

interface GroupsProps {
  agents: Agents;
  activity: ActivityByKey;
  query: string;
}

function NoMatch() {
  const { t } = useTranslation();
  return (
    <p className="px-2 py-4 text-center text-app-ui-sm text-muted-foreground">
      {t("agentList.list.no_match")}
    </p>
  );
}

function NoWorkspaces() {
  const { t } = useTranslation();
  return (
    <p className="px-2 py-4 text-center text-app-ui-sm text-muted-foreground whitespace-pre-line">
      {t("sidebar.no_workspaces")}
    </p>
  );
}

export function StatusGroups({
  agents,
  activity,
  query,
  remote,
  results,
}: GroupsProps & { remote: readonly RemoteStatusSource[]; results: RemoteResults }) {
  const folded = useAgentViewStore((s) => s.folded);
  const order = useAgentViewStore((s) => s.order);
  const pending = useConsentIsPending();
  const tree = useMemo(
    () => sessionTree([...agents.byKey.values()].map((entry) => entry.session)),
    [agents],
  );
  const searching = query.trim() !== "";
  const local = useMemo(() => statusTrees(searchSessionTree(tree, query)), [tree, query]);
  const { groups: remoteGroups, consents } = statusGroups([], remote, query, pending);
  const groups = remoteGroups.map(({ group, rows: remoteRows }) => {
    const key = `status:${group}`;
    const rows: (LocalStatusTree | Extract<StatusRow, { kind: "remote" }>)[] = [
      ...local[group].map(
        (node): LocalStatusTree => ({ kind: "local", node, key: node.session.key }),
      ),
      ...remoteRows.filter((row) => row.kind === "remote"),
    ];
    const since = (row: (typeof rows)[number]) => row.node.since;
    rows.sort((a, b) => compareStatusTime(group, since(a), since(b)));
    const localRows = rows.filter((row) => row.kind === "local");
    const ordered = orderSessions(localRows, order[key]);
    return {
      group,
      key,
      rows:
        ordered === localRows
          ? rows
          : reorderSubset(
              rows,
              ordered.map((row) => row.key),
              (row) => row.node.session.key,
            ),
    };
  });
  const { reorder } = useStableHandlers<{ reorder: SessionReorder }>({
    reorder(moved, target, edge) {
      const group = groups.find(({ rows }) =>
        rows.some((row) => row.kind === "local" && row.key === target),
      );
      if (!group) return;
      const keys = group.rows.filter((row) => row.kind === "local").map((row) => row.key);
      useAgentViewStore
        .getState()
        .setOrder(group.key, moveSessionRoot(keys, keys, moved, target, edge));
    },
  });
  if (
    agents.families.length === 0 &&
    tree.length === 0 &&
    consents.length === 0 &&
    !remote.some(({ list }) => list.sessions.some(listedByDefault))
  )
    return <NoWorkspaces />;
  if (searching && !consents.length && groups.every(({ rows }) => rows.length === 0))
    return <NoMatch />;
  return (
    <StatusSections
      searching={searching}
      className="flex flex-col gap-1"
      sectionClassName="flex flex-col"
      testId="agent-sidebar-status"
      sectionTestId="agent-sidebar-group"
      testPrefix="agent-sidebar"
      sections={groups.map(({ group, key, rows }) => {
        const cards = group === "attention" ? consents : [];
        return {
          group,
          count: rows.length + cards.length,
          folded: !searching && folded.has(key),
          onToggle: () => useAgentViewStore.getState().toggleFolded(key),
          onMarkRead:
            group === "done"
              ? () => {
                  const local: InboxItem[] = [];
                  const remote: Parameters<RemoteResults["markSeen"]>[0][number][] = [];
                  for (const row of rows) {
                    if (row.kind === "remote") {
                      for (const member of treeSessions([row.node])) {
                        const session = row.byKey.get(member.key);
                        if (session)
                          remote.push({
                            deviceId: row.peer.id,
                            session,
                            hostReceipts: peerServes(row.peer, "sessions.markSeen"),
                          });
                      }
                    } else {
                      for (const session of treeSessions([row.node])) {
                        const entry = agents.byKey.get(session.key);
                        if (entry) local.push({ workspace: entry.workspace, session });
                      }
                    }
                  }
                  markRead(local);
                  results.markSeen(remote);
                }
              : undefined,
          body: () => (
            <>
              {cards.length > 0 && (
                <div className="flex flex-col px-1 py-1" data-testid="remote-consents">
                  <ConsentPages place="agent-sidebar">
                    {cards.map(({ consent, source: { peer, list }, workspace }) => (
                      <PeerConsentCard
                        key={JSON.stringify([peer.id, consent.id])}
                        consent={consent}
                        deviceId={peer.id}
                        device={remoteDisplayName(peer.name)}
                        workspaceName={workspace?.name ?? shortId(consent.workspaceId)}
                        sessions={list.sessions}
                      />
                    ))}
                  </ConsentPages>
                </div>
              )}
              {rows.map((row) =>
                row.kind === "local" ? (
                  <SessionBranch
                    key={row.key}
                    node={row.node}
                    rootWorkspaceId={row.node.session.workspaceId}
                    agents={agents}
                    activity={activity}
                    folded={folded}
                    searching={searching}
                    group={group}
                    dragScope={key}
                    onReorder={!searching && local[group].length > 1 ? reorder : undefined}
                  />
                ) : (
                  <RemoteSessionBranch
                    key={row.node.session.key}
                    root={row.node}
                    folded={folded}
                    searching={searching}
                    groupIdle
                    navigation={row.navigation}
                    workspaceOf={(id) => row.workspaces.get(id)}
                    renderRow={(node, tree) => {
                      const session = row.byKey.get(node.session.key);
                      if (!session) return null;
                      return (
                        <>
                          <OpenRemoteSessionRow
                            session={session}
                            peer={row.peer}
                            workspace={row.workspaces.get(session.workspaceId)}
                            resultFeed={results}
                            showContext
                            tree={tree}
                          />
                          <AgentRows
                            agents={agentRunsOf(session.agents)}
                            selectedId={undefined}
                            className="pl-4"
                          />
                        </>
                      );
                    }}
                  />
                ),
              )}
            </>
          ),
        };
      })}
    />
  );
}

type LocalStatusTree = { kind: "local"; key: string; node: SessionTreeNode };

export function WorkspaceGroups({ agents, activity, query }: GroupsProps) {
  const order = useAgentViewStore((s) => s.order);
  const folded = useAgentViewStore((s) => s.folded);
  const reordering = useSessionReordering();

  const searching = query.trim() !== "";
  const tree = useMemo(
    () =>
      sessionTree(
        agents.families.flatMap((family) =>
          family.worktrees.flatMap((worktree) => worktree.sessions),
        ),
      ),
    [agents.families],
  );
  const roots = useMemo(() => searchSessionTree(tree, query), [tree, query]);
  const groups = useMemo(
    () => workspaceTrees(agents.families, roots, order, searching),
    [agents.families, roots, order, searching],
  );
  const { reorder } = useStableHandlers<{ reorder: SessionReorder }>({
    reorder(moved, target, edge) {
      const workspaceId = parseSessionKey(target)?.workspaceId;
      const placed = groups
        .flatMap(({ worktrees }) => worktrees)
        .find(({ worktree }) => worktree.workspace.id === workspaceId);
      if (!placed || !workspaceId) return;
      const view = useAgentViewStore.getState();
      const keys = orderSessions(placed.worktree.sessions, view.order[workspaceId]).map(
        (each) => each.key,
      );
      view.setOrder(
        workspaceId,
        moveSessionRoot(
          keys,
          placed.roots.map(({ session }) => session.key),
          moved,
          target,
          edge,
        ),
      );
    },
  });
  if (groups.length === 0) return <NoMatch />;

  return groups.map(({ family, worktrees }) => {
    const key = `workspace:${family.root.id}`;
    return (
      <FamilyGroup
        key={family.root.id}
        family={family}
        worktrees={worktrees}
        folded={!searching && folded.has(key)}
        folds={folded}
        searching={searching}
        agents={agents}
        reordering={reordering?.workspaceId}
        onToggle={() => useAgentViewStore.getState().toggleFolded(key)}
        activity={activity}
        onReorder={searching ? undefined : reorder}
      />
    );
  });
}

function FamilyGroup({
  family,
  worktrees,
  folded,
  folds,
  searching,
  agents,
  reordering,
  onToggle,
  activity,
  onReorder,
}: {
  family: SessionFamily;
  worktrees: readonly SidebarWorktree[];
  folded: boolean;
  folds: ReadonlySet<string>;
  searching: boolean;
  agents: Agents;
  reordering?: string;
  onToggle: () => void;
  activity: ActivityByKey;
  onReorder?: SessionReorder;
}) {
  const { t } = useTranslation();
  const root = family.root;
  const counts = { attention: 0, running: 0, done: 0, idle: 0 };
  let hidden = 0;
  for (const { worktree, roots } of worktrees) {
    for (const node of roots) {
      if (folded && worktree.workspace.id !== reordering && node.group === "idle")
        hidden += node.count + 1;
    }
    for (const session of treeSessions(roots)) counts[session.phase]++;
  }
  const rootFolded = folded && root.id !== reordering;
  const update = useWorkspaceUpdate(root);
  const handoff = useContextMenuHandoff();
  const rename = useWorkspaceRename(root, update);
  return (
    <section
      aria-label={root.name}
      className="mt-1 flex flex-col not-first:mt-3"
      data-testid="agent-sidebar-group"
      onDragLeave={(event) => leaveWorkspaceReorder(event)}
    >
      <ContextMenuRoot>
        <ContextMenuTrigger>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: hovering during a native row drag reveals its drop targets */}
          <div
            className="flex h-7 min-w-0 items-center gap-1.5 rounded-(--radius-control) pr-1 pl-1 hover:bg-[var(--state-hover-bg)]"
            onDragOver={onReorder ? (event) => hoverWorkspaceReorder(event, root.id) : undefined}
          >
            {rename.renaming ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch">
                <FoldChevron folded={rootFolded} />
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: workspaceColor(root.id, root.color) }}
                />
                <WorkspaceNameInput
                  rename={rename}
                  className="m-0 min-w-0 flex-1 border-0 bg-transparent p-0 text-app-ui-sm font-medium text-foreground outline-none"
                />
              </div>
            ) : (
              <button
                type="button"
                aria-expanded={!rootFolded}
                onClick={onToggle}
                className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <FoldChevron folded={rootFolded} />
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: workspaceColor(root.id, root.color) }}
                />
                <span className="min-w-0 truncate text-app-ui-sm font-medium text-foreground">
                  {root.name}
                </span>
                <WhereLabel workspace={root} />
                <span className="flex-1" />
                {hidden > 0 && <HiddenSessionCount count={hidden} />}
                <StateSummary counts={counts} />
              </button>
            )}
            {!rename.renaming && <NewAgentMenu workspace={root} />}
          </div>
        </ContextMenuTrigger>
        <WorkspaceMenuContent
          workspace={root}
          handoff={handoff}
          onTogglePin={() => update({ pinned: !root.pinned })}
          onRename={rename.start}
          onColor={(color) => update({ color })}
        />
      </ContextMenuRoot>
      {worktrees.map(({ worktree, roots, hosted }) => {
        const foldedHere = folded && reordering !== worktree.workspace.id;
        const visible = foldedHere ? roots.filter((node) => node.group !== "idle") : roots;
        if (foldedHere && visible.length === 0) return null;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: restores the fold when a native row drag leaves
          <div
            key={worktree.workspace.id}
            onDragLeave={(event) => leaveWorkspaceReorder(event, undefined, worktree.workspace.id)}
            className={cn("flex flex-col", !worktree.isRoot && "ml-3")}
          >
            {!worktree.isRoot && (
              // biome-ignore lint/a11y/noStaticElementInteractions: hovering during a native row drag reveals its drop targets
              <div
                className="flex h-6 min-w-0 items-center gap-1.5 pr-1 pl-2 text-app-micro text-muted-foreground"
                onDragOver={
                  onReorder && roots.length > 1
                    ? (event) => hoverWorkspaceReorder(event, worktree.workspace.id)
                    : undefined
                }
              >
                <GitBranch aria-hidden className="size-3 shrink-0" />
                <span className="min-w-0 truncate">
                  {worktree.branch ?? worktree.workspace.name}
                </span>
                <span className="shrink-0 rounded-full border border-border px-1.5 whitespace-nowrap">
                  {t("agentView.list.worktree")}
                </span>
                <span className="flex-1" />
                <NewAgentMenu workspace={worktree.workspace} />
              </div>
            )}
            {visible.map((node) => (
              <SessionBranch
                key={node.session.key}
                node={node}
                rootWorkspaceId={worktree.workspace.id}
                agents={agents}
                activity={activity}
                folded={folds}
                searching={searching}
                onReorder={roots.length > 1 ? onReorder : undefined}
              />
            ))}
            {worktree.isRoot && roots.length === 0 && hosted === 0 && (
              <p className="py-1 pl-7 text-app-micro text-muted-foreground">
                {t("agentView.list.no_agents")}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

interface SessionBranchProps {
  node: SessionTreeNode;
  rootWorkspaceId: string;
  agents: Agents;
  activity: ActivityByKey;
  folded: ReadonlySet<string>;
  searching: boolean;
  group?: RowGroup;
  dragScope?: string;
  onReorder?: SessionReorder;
}

function SessionBranch({
  node,
  rootWorkspaceId,
  agents,
  activity,
  folded,
  searching,
  group,
  dragScope,
  onReorder,
}: SessionBranchProps) {
  const { session } = node;
  const scope = dragScope ?? session.workspaceId;
  const { edge, dropProps } = useSessionDrop({ key: session.key, workspaceId: scope }, onReorder);
  const content = (
    <SessionTreeBranch
      node={node}
      folded={folded}
      searching={searching}
      groupIdle={group !== undefined}
      testPrefix="agent-sidebar"
      renderRow={(branchNode, collapsed) => {
        const current = branchNode.session;
        const placed = agents.byKey.get(current.key);
        const told =
          (group !== undefined && branchNode.depth === 0) ||
          current.workspaceId !== rootWorkspaceId;
        return (
          <AgentItem
            session={current}
            run={activity.get(current.key)}
            place={told && placed ? placeOf(placed) : undefined}
            dragScope={branchNode.depth === 0 ? scope : current.workspaceId}
            draggable={branchNode.depth === 0}
            parentName={visibleParentName(branchNode)}
            parentClosed={branchNode.parentClosed}
            familyCount={branchNode.count}
            collapsed={collapsed}
            counts={branchNode.counts}
          />
        );
      }}
    />
  );
  if (!onReorder) return content;
  return (
    <div className="relative" {...dropProps}>
      <SidebarDropIndicator edge={edge} />
      {content}
    </div>
  );
}

function WhereLabel({ workspace }: { workspace: WorkspaceMeta }) {
  const status = useWorkspacesStore((s) => selectWorkspaceConnectionStatus(s, workspace.id));
  const label = locationLabel(workspace.location, { prefix: true });
  if (label === null) return null;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-app-micro text-muted-foreground">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", connectionStatusClassName(status))}
      />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

const NewAgentMenu = memo(function NewAgentMenu({ workspace }: { workspace: WorkspaceMeta }) {
  const { t } = useTranslation();
  const start = (kind: "claude" | "codex", profileId?: string) => {
    const open = kind === "claude" ? openClaudeTab : openCodexTab;
    const tab = open(workspace.id, {
      cwd: workspace.rootPath,
      ...(profileId ? { profileId } : {}),
    });
    showInAgentView(workspace.id, tab.id);
  };
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <IconButton label={t("agentView.list.new_agent", { name: workspace.name })} size="xs">
          <Plus aria-hidden className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <NewChatMenuItems
          workspaceId={workspace.id}
          agent="claude"
          onOpen={(profileId) => start("claude", profileId)}
        />
        <NewChatMenuItems
          workspaceId={workspace.id}
          agent="codex"
          onOpen={(profileId) => start("codex", profileId)}
        />
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
});

const AgentItem = memo(function AgentItem({
  session,
  run,
  place,
  dragScope,
  draggable,
  parentName,
  parentClosed,
  familyCount,
  collapsed,
  counts,
}: {
  session: AgentSession;
  run: SessionActivity | undefined;
  place?: RowPlace;
  dragScope: string;
  draggable: boolean;
  parentName?: string;
  parentClosed?: true;
  familyCount: number;
  collapsed: boolean;
  counts: SessionCounts;
}) {
  const key = session.key;
  const where = useAgentViewStore((s) => panelPlaceOf(s.root, key));
  const duration = useDurationLabel(session.since);
  const facts = useRowFacts(session, run);
  const preview = useRowLine(session, facts);
  const show = () => showInAgentView(session.workspaceId, session.tabId);
  const hover = (on: boolean) => useAgentViewStore.getState().setHovered(on ? key : null);
  const { open } = useSessionParent(parentClosed ? session.parent : undefined);
  const closed = parentClosed && !open;
  const parent = useParentCaption(open?.title || parentName, session.parent?.device, closed);
  const attention = session.phase === "attention";
  return (
    <div
      className={rowShellClass({ attention, selected: where === "shown" && PANEL_SHOWN_BG })}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      data-testid="agent-sidebar-item"
      data-session-key={key}
    >
      {where && <PanelMark where={where} testId="agent-sidebar-panel" />}
      <button
        type="button"
        draggable={draggable}
        aria-label={session.title}
        onClick={show}
        data-agent-row=""
        onDragStart={
          draggable ? (e) => startSessionDrag(e, { key, workspaceId: dragScope }) : undefined
        }
        onDragEnd={draggable ? endSessionDrag : undefined}
        className="absolute inset-0 rounded-(--radius-raised) outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <SessionRowLines
        icon={<AgentMark session={session} />}
        title={session.title}
        sign={<SessionSign session={session} facts={facts} testId="agent-sidebar-state" />}
        time={duration}
        timeHint={stateLabel(session)}
        urgent={attention && session.state !== "error"}
        place={place}
        placeTestId={place?.kind === "branch" ? "agent-sidebar-branch" : "agent-sidebar-workspace"}
        parent={
          parent && (
            <span
              className={cn("max-w-40 min-w-0 shrink-[2] truncate", closed && "opacity-70")}
              title={parent.hint}
              data-testid="agent-sidebar-parent"
            >
              {parent.label}
            </span>
          )
        }
        preview={preview}
        family={
          familyCount > 0 && (
            <FamilyFold
              session={session}
              count={familyCount}
              collapsed={collapsed}
              counts={counts}
              testPrefix="agent-sidebar"
            />
          )
        }
      />
      {session.kind !== "terminal" && (
        <div className="pointer-events-none relative">
          <GoalRowLine workspaceId={session.workspaceId} tabId={session.tabId} />
        </div>
      )}
      <AgentRows
        agents={run?.agents ?? []}
        selectedId={undefined}
        onSelect={show}
        className="relative mt-0.5 pl-4"
      />
    </div>
  );
});

function placeOf({
  workspace,
  root,
}: {
  readonly workspace: WorkspaceMeta;
  readonly root: WorkspaceMeta;
}): RowPlace {
  const branch = workspace.task?.branch;
  if (branch) return { kind: "branch", name: branch, hint: `${root.name} · ${branch}` };
  return {
    kind: "workspace",
    name: workspace.name,
    color: workspaceColor(root.id, root.color),
    hint: workspace.id === root.id ? root.name : `${root.name} · ${workspace.name}`,
  };
}
