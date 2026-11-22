// The agent view's list: every workspace's agents, grouped by their state
// (waiting on the user, running, with a new result, idle, ended) or by the
// workspace they run in, a workspace's tasks set in below it, in the
// sidebar's order. A row shows its agent in a panel, by a click or dragged
// where it should go; dragged among its workspace's rows, it takes the place
// it is dropped on; ↑ and ↓ step between rows. The eye tells which already
// are shown, and the pointer on a row lights up the panel it is in. The
// search box finds agents by their title, last prompt or last answer, as
// the agent list's does. The grouping and the folded groups are kept across
// restarts.

import { CheckCheck, ChevronDown, ChevronRight, GitBranch, Plus } from "lucide-react";
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
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { AgentRows } from "../agent-list/agent-rows";
import {
  FailureLabel,
  HiddenSessionCount,
  StateGlyph,
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
import { AgentMark, GROUP_STATE, GROUP_TINT, RowLine } from "../agent-list/status-view";
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
import { PeerConsentCard, useConsentIsPending } from "./remote-consents";
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

// Memo: kept while hidden, it would render again with each of the app's.
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
    // The sidebar's shell and width, so switching views keeps the layout.
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
        {/* ↑ ↓ step between the agents' rows, Home and End to the first and last;
            ↑ on the first goes back to the search box. */}
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

/** Moves the focus from one agent's row to the next or previous one in the list, as shown. */
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

/**
 * The search box's keys for the list under it: ↓ goes to the first agent
 * it lists, and Enter, with a query, opens that agent.
 */
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
  /** What the search box holds: only the agents it finds are listed, in groups that are open. */
  query: string;
}

/** What the list says when the search finds no agent. */
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

/**
 * Every agent by its state, the agent list's groups in its order: those
 * waiting on the user longest first, the latest first in the others. A row
 * tells the workspace it runs in; one with none shows as a dim line, so the
 * groups keep their places.
 */
export function StatusGroups({
  agents,
  activity,
  query,
  remote,
  results,
}: GroupsProps & { remote: readonly RemoteStatusSource[]; results: RemoteResults }) {
  const { t } = useTranslation();
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
    <div className="flex flex-col gap-1" data-testid="agent-sidebar-status">
      {groups.map(({ group, key, rows }) => {
        const label = t(`agentList.group.${group}`);
        const cards = group === "attention" ? consents : [];
        const count = rows.length + cards.length;
        if (count === 0) {
          // A search tells only what it found.
          if (searching) return null;
          return (
            <section key={group} aria-label={label}>
              <h3 className="flex h-7 items-center gap-1.5 px-2 text-app-ui-sm text-muted-foreground opacity-60">
                <StateGlyph state={GROUP_STATE[group]} still />
                <span>{label}</span>
                <span className="tabular-nums">0</span>
              </h3>
            </section>
          );
        }
        // A search shows what it found, in folded groups too.
        const isFolded = !searching && folded.has(key);
        return (
          <section
            key={group}
            aria-label={label}
            className="flex flex-col"
            data-testid="agent-sidebar-group"
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-expanded={!isFolded}
                onClick={() => useAgentViewStore.getState().toggleFolded(key)}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-(--radius-control) px-2 text-app-ui-sm font-medium whitespace-nowrap outline-none hover:bg-[var(--state-hover-bg)] focus-visible:ring-1 focus-visible:ring-ring",
                  GROUP_TINT[group],
                )}
              >
                <StateGlyph state={GROUP_STATE[group]} />
                <span>{label}</span>
                <span className="tabular-nums">{count}</span>
                {isFolded ? (
                  <ChevronRight aria-hidden className="size-3.5" />
                ) : (
                  <ChevronDown aria-hidden className="size-3.5" />
                )}
              </button>
              {group === "done" && (
                <MarkAllRead
                  onMark={() => {
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
                  }}
                />
              )}
            </div>
            {!isFolded && cards.length > 0 && (
              <div className="flex flex-col gap-1.5 px-1 py-1" data-testid="remote-consents">
                {cards.map(({ consent, source: { peer, list }, workspace }) => (
                  <PeerConsentCard
                    key={JSON.stringify([peer.id, consent.id])}
                    consent={consent}
                    deviceId={peer.id}
                    device={remoteDisplayName(peer.name)}
                    workspaceName={workspace?.name ?? consent.workspaceId.slice(0, 8)}
                    sessions={list.sessions}
                  />
                ))}
              </div>
            )}
            {!isFolded &&
              rows.map((row) => {
                return row.kind === "local" ? (
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
                    renderRow={(node) => {
                      const session = row.byKey.get(node.session.key);
                      if (!session) return null;
                      return (
                        <>
                          <OpenRemoteSessionRow
                            session={session}
                            peer={row.peer}
                            workspace={row.workspaces.get(session.workspaceId)}
                            resultFeed={results}
                            sectionGroup={group}
                            showContext
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
                );
              })}
          </section>
        );
      })}
    </div>
  );
}

type LocalStatusTree = { kind: "local"; key: string; node: SessionTreeNode };

/** Marks every new result of the group read, as the inbox's "Mark new results read" does. */
function MarkAllRead({ onMark }: { onMark: () => void }) {
  const { t } = useTranslation();
  return (
    <IconButton label={t("inbox.mark_read")} onClick={onMark} data-testid="agent-sidebar-mark-read">
      <CheckCheck aria-hidden className="size-3.5" />
    </IconButton>
  );
}

/** Every workspace with its tasks and their agents, in the sidebar's order and the one dragged into. */
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
      // A space between workspaces, so each one's agents read as its own.
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
            {/* While renaming, the name is a field and the fold button gives way to a plain row,
                so a click in the field never folds the group. */}
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
      {worktrees.map(({ worktree, roots, moved }) => {
        const foldedHere = folded && reordering !== worktree.workspace.id;
        const visible = foldedHere ? roots.filter((node) => node.group !== "idle") : roots;
        if (foldedHere && visible.length === 0 && moved.length === 0) return null;
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
            {moved.map(({ key, title, count }) => (
              <span
                key={key}
                className="min-w-0 truncate px-2 py-1 pl-6 text-app-micro text-muted-foreground"
                title={t("agentView.list.moved_family", { name: title, count })}
                data-testid="agent-sidebar-moved"
              >
                {t("agentView.list.moved_family", { name: title, count })}
              </span>
            ))}
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
            {worktree.isRoot && roots.length === 0 && (
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
        return (
          <AgentItem
            session={current}
            run={activity.get(current.key)}
            where={group !== undefined ? placed : undefined}
            group={group}
            dragScope={branchNode.depth === 0 ? scope : current.workspaceId}
            draggable={branchNode.depth === 0}
            branch={
              current.workspaceId !== rootWorkspaceId ? placed?.workspace.task?.branch : undefined
            }
            parentName={visibleParentName(branchNode)}
            parentClosed={branchNode.parentClosed}
            familyCount={branchNode.count}
            collapsed={collapsed}
            counts={collapsed ? branchNode.counts : undefined}
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

/** Where a remote workspace runs, with how its connection stands. */
function WhereLabel({ workspace }: { workspace: WorkspaceMeta }) {
  const status = useWorkspacesStore((s) => selectWorkspaceConnectionStatus(s, workspace.id));
  const location = workspace.location;
  if (location.kind === "local") return null;
  const label =
    location.kind === "ssh"
      ? `ssh: ${location.configAlias ?? (location.user ? `${location.user}@${location.host}` : location.host)}`
      : `wsl: ${location.distro}`;
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

/**
 * The + that starts a Claude or Codex conversation in a workspace, shown in
 * a panel: with the profile the workspace gives, or, where there is more
 * than one, another picked from its submenu, as the tab bar's + does.
 */
// Memo: a Radix menu for each workspace and task, which their list renders with each change of any agent's.
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

/**
 * Memoized, and reads its own conversation's facts (use-row-facts): a
 * chunk of a reply streaming in, here or in another tab, renders no row
 * whose facts it leaves as they were.
 */
const AgentItem = memo(function AgentItem({
  session,
  run,
  where: placed,
  group,
  dragScope,
  draggable,
  branch,
  parentName,
  parentClosed,
  familyCount,
  collapsed,
  counts,
}: {
  session: AgentSession;
  /** What its hooks report, when they do. */
  run: SessionActivity | undefined;
  /** The workspace shown in the status list. */
  where?: { readonly workspace: WorkspaceMeta; readonly root: WorkspaceMeta };
  group?: RowGroup;
  dragScope: string;
  draggable: boolean;
  branch?: string;
  parentName?: string;
  parentClosed?: true;
  familyCount: number;
  collapsed: boolean;
  counts?: SessionCounts;
}) {
  const key = session.key;
  const where = useAgentViewStore((s) => panelPlaceOf(s.root, key));
  const duration = useDurationLabel(session.since);
  const facts = useRowFacts(session, run);
  const show = () => showInAgentView(session.workspaceId, session.tabId);
  const hover = (on: boolean) => useAgentViewStore.getState().setHovered(on ? key : null);
  const parent = useParentCaption(parentName, session.parent?.device, parentClosed);
  const preview = <RowLine session={session} facts={facts} />;
  return (
    <div
      className={cn(
        "relative rounded-(--radius-raised) border px-2 py-1.5 text-app-ui-sm transition-colors",
        session.phase === "attention" ? "border-(--state-warning-fg)/40" : "border-transparent",
        where === "shown"
          ? PANEL_SHOWN_BG
          : cn(
              session.phase === "attention" && "bg-(--state-warning-fg)/5",
              "hover:bg-[var(--state-hover-bg)]",
            ),
      )}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      data-testid="agent-sidebar-item"
      data-session-key={key}
    >
      {where && <PanelMark where={where} testId="agent-sidebar-panel" />}
      {/* The row as one button behind its content, so the subagents' buttons stay buttons. */}
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
      <div className="pointer-events-none relative flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <AgentMark session={session} />
          <span className="min-w-0 flex-1 truncate text-foreground" title={session.title}>
            {session.title}
          </span>
          {/* Its state at a glance, the glyph its filter has (running, waiting
              on the user, done, or idle), and for how long. */}
          <span className="flex shrink-0 items-center gap-1">
            {group !== session.phase && session.state !== "error" && (
              <span
                role="img"
                aria-label={stateLabel(session)}
                title={stateLabel(session)}
                className="inline-flex"
                data-testid="agent-sidebar-state"
              >
                <StateGlyph state={session.state} />
              </span>
            )}
            {session.state === "error" && <FailureLabel />}
            {duration && (
              <span
                className={cn(
                  "text-app-micro whitespace-nowrap tabular-nums",
                  session.phase === "attention" && session.state !== "error"
                    ? "text-(--state-warning-fg)"
                    : "text-muted-foreground",
                )}
                title={stateLabel(session)}
              >
                {duration}
              </span>
            )}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pl-5.5 text-app-micro">
          {branch ? (
            <span
              className="inline-flex max-w-[45%] min-w-0 items-center gap-0.5 rounded-full border border-border px-1.5 font-mono text-muted-foreground"
              title={branch}
              data-testid="agent-sidebar-branch"
            >
              <GitBranch aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          ) : (
            placed && (
              <WorkspaceTag
                workspace={placed.workspace}
                root={placed.root}
                compact={familyCount > 0 || parent !== undefined}
              />
            )
          )}
          {parent ? (
            <div className="flex min-w-0 grow basis-1/2 items-center gap-1.5 overflow-hidden">
              <span
                className={cn(
                  "max-w-[60%] shrink-0 truncate text-muted-foreground",
                  parentClosed && "opacity-70",
                )}
                title={parent.hint}
                data-testid="agent-sidebar-parent"
              >
                {parent.label}
              </span>
              {preview}
            </div>
          ) : (
            preview
          )}
          {familyCount > 0 && (
            <FamilyFold
              session={session}
              count={familyCount}
              collapsed={collapsed}
              testPrefix="agent-sidebar"
            />
          )}
          {counts && <StateSummary counts={counts} compact />}
        </div>
        {session.kind !== "terminal" && (
          <GoalRowLine workspaceId={session.workspaceId} tabId={session.tabId} />
        )}
      </div>
      <AgentRows
        agents={run?.agents ?? []}
        selectedId={undefined}
        onSelect={show}
        className="relative mt-0.5 pl-4"
      />
    </div>
  );
});

/** The workspace an agent runs in, by its color and name, where the list is by state. */
function WorkspaceTag({
  workspace,
  root,
  compact = false,
}: {
  workspace: WorkspaceMeta;
  root: WorkspaceMeta;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex max-w-[45%] items-center gap-1 text-muted-foreground",
        compact ? "min-w-0" : "shrink-0",
      )}
      title={workspace.id === root.id ? root.name : `${root.name} · ${workspace.name}`}
      data-testid="agent-sidebar-workspace"
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: workspaceColor(root.id, root.color) }}
      />
      <span className="min-w-0 truncate">{workspace.name}</span>
    </span>
  );
}
