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
import type { ActivityByKey } from "@/services/agent-sessions/agents";
import type { InboxItem } from "@/services/agent-sessions/inbox";
import type { AgentSession, SessionFamily, WorktreeEntry } from "@/services/agent-sessions/model";
import { groupOf, listed, matchesQuery, type RowGroup } from "@/services/agent-sessions/rows";
import { useSessionActivity } from "@/services/agent-sessions/use-family";
import { markRead } from "@/services/agent-sessions/use-inbox";
import { useRowFacts } from "@/services/agent-sessions/use-row-facts";
import { type Agents, workspaceColor } from "@/services/agent-view/agents";
import { parseSessionKey, remoteSessionKey } from "@/services/agent-view/layout";
import { moveKey, orderSessions } from "@/services/agent-view/order";
import type { RemoteResults } from "@/services/agent-view/remote-results";
import { showInAgentView } from "@/services/agent-view/show";
import { useAgents } from "@/services/agent-view/use-agents";
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
import {
  agentRunsOf,
  OpenRemoteSessionRow,
  RemoteSessions,
  type RemoteStatusSource,
  statusGroups,
} from "./remote-sessions";
import {
  endSessionDrag,
  type SessionReorder,
  startSessionDrag,
  useSessionDrag,
  useSessionDrop,
} from "./session-drop";
import { SidebarDropIndicator } from "./sidebar-drop";

const GROUPINGS: readonly AgentListGrouping[] = ["status", "workspace"];

/** The groups a workspace's header counts: the ones that ask for a look. */
const SUMMED: readonly RowGroup[] = ["attention", "running", "done"];

// Memo: kept while hidden, it would render again with each of the app's.
export const AgentSidebar = memo(function AgentSidebar() {
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
              <p className="px-2 py-4 text-center text-app-ui-sm text-muted-foreground whitespace-pre-line">
                {t("sidebar.no_workspaces")}
              </p>
            ) : (
              <WorkspaceGroups agents={agents} activity={activity} query={query} />
            ))}
          <RemoteSessions
            query={query}
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
function stepRows(event: KeyboardEvent<HTMLDivElement>, search: HTMLElement | null): void {
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
function fromSearch(event: KeyboardEvent<HTMLInputElement>, list: HTMLElement | null): void {
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
  const pending = useConsentIsPending();
  const sessions = useMemo(
    () => [...agents.byKey.values()].map((entry) => entry.session),
    [agents],
  );
  const searching = query.trim() !== "";
  const { groups, consents } = statusGroups(sessions, remote, query, pending);
  if (searching && !consents.length && groups.every(({ rows }) => rows.length === 0))
    return <NoMatch />;
  return (
    <div className="flex flex-col gap-1" data-testid="agent-sidebar-status">
      {groups.map(({ group, rows }) => {
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
        const key = `status:${group}`;
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
                        remote.push({ deviceId: row.peer.id, session: row.session });
                      } else {
                        const entry = agents.byKey.get(row.session.key);
                        if (entry) local.push({ workspace: entry.workspace, session: row.session });
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
                    device={peer.name}
                    workspaceName={workspace?.name ?? consent.workspaceId.slice(0, 8)}
                    sessions={list.sessions}
                  />
                ))}
              </div>
            )}
            {!isFolded &&
              rows.map((row) => {
                return row.kind === "local" ? (
                  <AgentItem
                    key={row.session.key}
                    session={row.session}
                    run={activity.get(row.session.key)}
                    where={agents.byKey.get(row.session.key)}
                  />
                ) : (
                  <div
                    key={remoteSessionKey({ deviceId: row.peer.id, ...row.session })}
                    className="flex flex-col"
                  >
                    <OpenRemoteSessionRow
                      session={row.session}
                      peer={row.peer}
                      workspace={row.workspace}
                      resultFeed={results}
                      showContext
                    />
                    <AgentRows
                      agents={agentRunsOf(row.session.agents)}
                      selectedId={undefined}
                      className="pl-4"
                    />
                  </div>
                );
              })}
          </section>
        );
      })}
    </div>
  );
}

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
  const dragging = useSessionDrag();

  const reorder: SessionReorder = (moved, target, edge) => {
    const workspaceId = parseSessionKey(target)?.workspaceId;
    const worktree = agents.families
      .flatMap((family) => family.worktrees)
      .find((each) => each.workspace.id === workspaceId);
    if (!worktree || !workspaceId) return;
    const view = useAgentViewStore.getState();
    const keys = orderSessions(worktree.sessions, view.order[workspaceId]).map((each) => each.key);
    view.setOrder(workspaceId, moveKey(keys, moved, target, edge));
  };

  const searching = query.trim() !== "";
  const groups = agents.families
    .map((family) => ({
      family,
      worktrees: family.worktrees
        .map((worktree) => ({
          worktree,
          sessions: orderSessions(worktree.sessions, order[worktree.workspace.id]).filter(
            (session) => listed(session) && matchesQuery(session, query),
          ),
        }))
        // A task shows with agents to list; the workspace itself does, for its + to start
        // one, unless a search found none of its agents.
        .filter(({ worktree, sessions }) => sessions.length > 0 || (worktree.isRoot && !searching)),
    }))
    .filter(({ worktrees }) => worktrees.length > 0);
  if (groups.length === 0) return <NoMatch />;

  return groups.map(({ family, worktrees }) => {
    const key = `workspace:${family.root.id}`;
    const reordering = worktrees.some(
      ({ worktree }) => worktree.workspace.id === dragging?.workspaceId,
    );
    return (
      <FamilyGroup
        key={family.root.id}
        family={family}
        worktrees={worktrees}
        folded={!searching && !reordering && folded.has(key)}
        onToggle={() => useAgentViewStore.getState().toggleFolded(key)}
        activity={activity}
        onReorder={searching ? undefined : reorder}
      />
    );
  });
}

/** How many of a workspace's agents wait on the user, run, or have a new result, the ones there are. */
function StateSummary({ sessions }: { sessions: readonly AgentSession[] }) {
  const { t } = useTranslation();
  const counts = SUMMED.map((group) => ({
    group,
    count: sessions.filter((session) => groupOf(session) === group).length,
  })).filter(({ count }) => count > 0);
  if (counts.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-2 text-app-micro whitespace-nowrap tabular-nums">
      {counts.map(({ group, count }) => (
        <span
          key={group}
          className={cn("inline-flex items-center gap-0.5", GROUP_TINT[group])}
          title={`${t(`agentList.group.${group}`)} ${count}`}
          data-testid="agent-sidebar-summary"
        >
          <StateGlyph state={GROUP_STATE[group]} />
          {count}
        </span>
      ))}
    </span>
  );
}

function FamilyGroup({
  family,
  worktrees,
  folded,
  onToggle,
  activity,
  onReorder,
}: {
  family: SessionFamily;
  worktrees: readonly { worktree: WorktreeEntry; sessions: readonly AgentSession[] }[];
  folded: boolean;
  onToggle: () => void;
  activity: ActivityByKey;
  onReorder?: SessionReorder;
}) {
  const { t } = useTranslation();
  const root = family.root;
  const all = worktrees.flatMap(({ sessions }) => sessions);
  const hidden = folded ? all.filter((session) => groupOf(session) === "idle").length : 0;
  const update = useWorkspaceUpdate(root);
  const handoff = useContextMenuHandoff();
  const rename = useWorkspaceRename(root, update);
  return (
    <section
      aria-label={root.name}
      // A space between workspaces, so each one's agents read as its own.
      className="mt-1 flex flex-col not-first:mt-3"
      data-testid="agent-sidebar-group"
    >
      <ContextMenuRoot>
        <ContextMenuTrigger>
          <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-(--radius-control) pr-1 pl-1 hover:bg-[var(--state-hover-bg)]">
            {/* While renaming, the name is a field and the fold button gives way to a plain row,
                so a click in the field never folds the group. */}
            {rename.renaming ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch">
                <FoldChevron folded={folded} />
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
                aria-expanded={!folded}
                onClick={onToggle}
                className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <FoldChevron folded={folded} />
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
                <StateSummary sessions={all} />
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
      {worktrees.map(({ worktree, sessions }) => {
        const visible = folded
          ? sessions.filter((session) => groupOf(session) !== "idle")
          : sessions;
        if (folded && visible.length === 0) return null;
        return (
          <div
            key={worktree.workspace.id}
            className={cn("flex flex-col", !worktree.isRoot && "ml-3")}
          >
            {!worktree.isRoot && (
              <div className="flex h-6 min-w-0 items-center gap-1.5 pr-1 pl-2 text-app-micro text-muted-foreground">
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
            {visible.map((session) => (
              <AgentItem
                key={session.key}
                session={session}
                run={activity.get(session.key)}
                onReorder={sessions.length > 1 ? onReorder : undefined}
              />
            ))}
            {worktree.isRoot && sessions.length === 0 && (
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

function FoldChevron({ folded }: { folded: boolean }) {
  const Icon = folded ? ChevronRight : ChevronDown;
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
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
  onReorder,
  where: placed,
}: {
  session: AgentSession;
  /** What its hooks report, when they do. */
  run: SessionActivity | undefined;
  /** Its place among its workspace's agents, dragged; none where the list is by state. */
  onReorder?: SessionReorder;
  /** Where the list is by state, the workspace it runs in, which its row tells; its group tells its state. */
  where?: { readonly workspace: WorkspaceMeta; readonly root: WorkspaceMeta };
}) {
  const key = session.key;
  const where = useAgentViewStore((s) => panelPlaceOf(s.root, key));
  const duration = useDurationLabel(session.since);
  const facts = useRowFacts(session, run);
  const show = () => showInAgentView(session.workspaceId, session.tabId);
  const hover = (on: boolean) => useAgentViewStore.getState().setHovered(on ? key : null);
  const dragRow = { key, workspaceId: session.workspaceId };
  const { edge, dropProps } = useSessionDrop(dragRow, onReorder);
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
      {...dropProps}
      data-testid="agent-sidebar-item"
      data-session-key={key}
    >
      <SidebarDropIndicator edge={edge} />
      {where && <PanelMark where={where} testId="agent-sidebar-panel" />}
      {/* The row as one button behind its content, so the subagents' buttons stay buttons. */}
      <button
        type="button"
        draggable
        aria-label={session.title}
        onClick={show}
        data-agent-row=""
        onDragStart={(e) => startSessionDrag(e, dragRow)}
        onDragEnd={endSessionDrag}
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
            {!placed && (
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
                  session.phase === "attention"
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
          {placed && <WorkspaceTag workspace={placed.workspace} root={placed.root} />}
          <RowLine session={session} facts={facts} />
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
function WorkspaceTag({ workspace, root }: { workspace: WorkspaceMeta; root: WorkspaceMeta }) {
  return (
    <span
      className="flex max-w-[45%] shrink-0 items-center gap-1 text-muted-foreground"
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
