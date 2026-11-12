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

import { CheckCheck, ChevronDown, ChevronRight, Eye, GitBranch, Plus } from "lucide-react";
import { type DragEvent, type KeyboardEvent, memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityByKey } from "@/services/agent-sessions/agents";
import type { InboxItem } from "@/services/agent-sessions/inbox";
import type { AgentSession, SessionFamily, WorktreeEntry } from "@/services/agent-sessions/model";
import {
  chatRowFacts,
  groupOf,
  hookRowFacts,
  matchesQuery,
  ROW_GROUPS,
  type RowGroup,
  sessionsIn,
} from "@/services/agent-sessions/rows";
import { useSessionActivity } from "@/services/agent-sessions/use-family";
import { markRead } from "@/services/agent-sessions/use-inbox";
import { type Agents, workspaceColor } from "@/services/agent-view/agents";
import { leafHolding, leafShowing, parseSessionKey } from "@/services/agent-view/layout";
import { moveKey, orderSessions } from "@/services/agent-view/order";
import { showInAgentView } from "@/services/agent-view/show";
import { useAgents } from "@/services/agent-view/use-agents";
import { type ChatTabState, chatKey, useChatStore } from "@/services/chat/store";
import { openClaudeTab, openCodexTab } from "@/state/operations/tabs";
import { type AgentListGrouping, useAgentViewStore } from "@/state/stores/agent-view";
import { useManagerStore } from "@/state/stores/manager";
import { useUIStore } from "@/state/stores/ui";
import { selectWorkspaceConnectionStatus, useWorkspacesStore } from "@/state/stores/workspaces";
import { cn } from "@/utils/cn";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { AgentRows } from "../agent-list/agent-rows";
import { StateGlyph, stateLabel, useDurationLabel } from "../agent-list/session-status";
import { AgentMark, GROUP_STATE, GROUP_TINT, RowLine } from "../agent-list/status-view";
import { NewChatMenuItems } from "../agent-profiles/new-chat-menu";
import { GoalRowLine } from "../chat/goal-bar";
import { ManagerChip } from "../manager/manager-chip";
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { IconButton } from "../ui/icon-button";
import { SearchInput } from "../ui/search-input";
import { connectionStatusClassName } from "../workbench/sidebar";
import { SidebarResizeHandle } from "../workbench/sidebar-resize-handle";
import { SystemStatsFooter } from "../workbench/system-stats";
import { listDrag, setAgentDrag, setListDrag } from "./drag";

type DropEdge = "before" | "after";

/** Moves the agent `moved` to just before or after `target`, among its workspace's. */
type Reorder = (moved: string, target: string, edge: DropEdge) => void;

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
  const chats = useChatStore((s) => s.tabs);
  const [query, setQuery] = useState("");

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
            <span className="mr-0.5 text-app-micro text-muted-foreground">
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
            data-testid="agent-sidebar-search"
          />
        </div>
        {/* ↑ ↓ step between the agents' rows, Home and End to the first and last. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the keys come from the rows' own buttons */}
        <div
          className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
          onKeyDown={stepRows}
        >
          {agents.families.length === 0 ? (
            <p className="px-2 py-4 text-center text-app-ui-sm text-muted-foreground whitespace-pre-line">
              {t("sidebar.no_workspaces")}
            </p>
          ) : grouping === "status" ? (
            <StatusGroups agents={agents} activity={activity} chats={chats} query={query} />
          ) : (
            <WorkspaceGroups agents={agents} activity={activity} chats={chats} query={query} />
          )}
        </div>
        <SystemStatsFooter />
      </div>
      <SidebarResizeHandle />
    </aside>
  );
});

/** Moves the focus from one agent's row to the next or previous one in the list, as shown. */
function stepRows(event: KeyboardEvent<HTMLDivElement>): void {
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
  if (!next) return;
  event.preventDefault();
  next.focus();
}

interface GroupsProps {
  agents: Agents;
  activity: ActivityByKey;
  chats: Record<string, ChatTabState>;
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
function StatusGroups({ agents, activity, chats, query }: GroupsProps) {
  const { t } = useTranslation();
  const folded = useAgentViewStore((s) => s.folded);
  const sessions = useMemo(
    () => [...agents.byKey.values()].map((entry) => entry.session),
    [agents],
  );
  const searching = query.trim() !== "";
  const groups = ROW_GROUPS.map((group) => ({ group, rows: sessionsIn(sessions, group, query) }));
  if (searching && groups.every(({ rows }) => rows.length === 0)) return <NoMatch />;
  return (
    <div className="flex flex-col gap-1" data-testid="agent-sidebar-status">
      {groups.map(({ group, rows }) => {
        const label = t(`agentList.group.${group}`);
        if (rows.length === 0) {
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
                  "flex h-7 items-center gap-1.5 rounded-(--radius-control) px-2 text-app-ui-sm font-medium outline-none hover:bg-[var(--state-hover-bg)] focus-visible:ring-1 focus-visible:ring-ring",
                  GROUP_TINT[group],
                )}
              >
                <StateGlyph state={GROUP_STATE[group]} />
                <span>{label}</span>
                <span className="tabular-nums">{rows.length}</span>
                {isFolded ? (
                  <ChevronRight aria-hidden className="size-3.5" />
                ) : (
                  <ChevronDown aria-hidden className="size-3.5" />
                )}
              </button>
              {group === "done" && (
                <MarkAllRead
                  items={rows.flatMap((session) => {
                    const entry = agents.byKey.get(session.key);
                    return entry ? [{ workspace: entry.workspace, session }] : [];
                  })}
                />
              )}
            </div>
            {!isFolded &&
              rows.map((session) => (
                <AgentItem
                  key={session.key}
                  session={session}
                  activity={activity}
                  chat={chats[chatKey(session.workspaceId, session.tabId)]}
                  where={agents.byKey.get(session.key)}
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}

/** Marks every new result of the group read, as the inbox's "Mark new results read" does. */
function MarkAllRead({ items }: { items: readonly InboxItem[] }) {
  const { t } = useTranslation();
  return (
    <IconButton
      label={t("inbox.mark_read")}
      onClick={() => markRead(items)}
      data-testid="agent-sidebar-mark-read"
    >
      <CheckCheck aria-hidden className="size-3.5" />
    </IconButton>
  );
}

/** Every workspace with its tasks and their agents, in the sidebar's order and the one dragged into. */
function WorkspaceGroups({ agents, activity, chats, query }: GroupsProps) {
  const order = useAgentViewStore((s) => s.order);
  const folded = useAgentViewStore((s) => s.folded);

  const reorder: Reorder = (moved, target, edge) => {
    const workspaceId = parseSessionKey(target)?.workspaceId;
    const worktree = agents.families
      .flatMap((family) => family.worktrees)
      .find((each) => each.workspace.id === workspaceId);
    if (!worktree || !workspaceId) return;
    const keys = orderSessions(worktree.sessions, order[workspaceId]).map((each) => each.key);
    useAgentViewStore.getState().setOrder(workspaceId, moveKey(keys, moved, target, edge));
  };

  const searching = query.trim() !== "";
  const groups = agents.families
    .map((family) => ({
      family,
      worktrees: family.worktrees
        .map((worktree) => ({
          worktree,
          sessions: orderSessions(worktree.sessions, order[worktree.workspace.id]).filter(
            (session) => matchesQuery(session, query),
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
    return (
      <FamilyGroup
        key={family.root.id}
        family={family}
        worktrees={worktrees}
        // A search shows what it found, in folded workspaces too.
        folded={!searching && folded.has(key)}
        onToggle={() => useAgentViewStore.getState().toggleFolded(key)}
        activity={activity}
        chats={chats}
        onReorder={reorder}
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
    <span className="flex shrink-0 items-center gap-2 text-app-micro tabular-nums">
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
  chats,
  onReorder,
}: {
  family: SessionFamily;
  worktrees: readonly { worktree: WorktreeEntry; sessions: readonly AgentSession[] }[];
  folded: boolean;
  onToggle: () => void;
  activity: ActivityByKey;
  chats: Record<string, ChatTabState>;
  onReorder: Reorder;
}) {
  const { t } = useTranslation();
  const root = family.root;
  const all = worktrees.flatMap(({ sessions }) => sessions);
  return (
    <section
      aria-label={root.name}
      className="mt-1 flex flex-col"
      data-testid="agent-sidebar-group"
    >
      <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-(--radius-control) pr-1 pl-1 hover:bg-[var(--state-hover-bg)]">
        <button
          type="button"
          aria-expanded={!folded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {folded ? (
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ background: workspaceColor(root.id) }}
          />
          <span className="min-w-0 truncate text-app-ui-sm font-medium text-foreground">
            {root.name}
          </span>
          <WhereLabel workspace={root} />
          <span className="flex-1" />
          <StateSummary sessions={all} />
        </button>
        <NewAgentMenu workspace={root} />
      </div>
      {!folded &&
        worktrees.map(({ worktree, sessions }) => (
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
                <span className="shrink-0 rounded-full border border-border px-1.5">
                  {t("agentView.list.worktree")}
                </span>
                <span className="flex-1" />
                <NewAgentMenu workspace={worktree.workspace} />
              </div>
            )}
            {sessions.map((session) => (
              <AgentItem
                key={session.key}
                session={session}
                activity={activity}
                chat={chats[chatKey(session.workspaceId, session.tabId)]}
                onReorder={onReorder}
              />
            ))}
            {worktree.isRoot && sessions.length === 0 && (
              <p className="py-1 pl-7 text-app-micro text-muted-foreground">
                {t("agentView.list.no_agents")}
              </p>
            )}
          </div>
        ))}
    </section>
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
function NewAgentMenu({ workspace }: { workspace: WorkspaceMeta }) {
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
}

/**
 * Where a row takes an agent dragged over it: before or after it, by the
 * half the pointer is in; null for one it cannot take, of another
 * workspace or itself.
 */
function dropEdgeOf(e: DragEvent<HTMLElement>, session: AgentSession): DropEdge | null {
  const moved = listDrag();
  if (!moved || moved === session.key) return null;
  if (parseSessionKey(moved)?.workspaceId !== session.workspaceId) return null;
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function AgentItem({
  session,
  activity,
  chat,
  onReorder,
  where: placed,
}: {
  session: AgentSession;
  activity: ActivityByKey;
  chat: ChatTabState | undefined;
  /** Its place among its workspace's agents, dragged; none where the list is by state. */
  onReorder?: Reorder;
  /** Where the list is by state, the workspace it runs in, which its row tells; its group tells its state. */
  where?: { readonly workspace: WorkspaceMeta; readonly root: WorkspaceMeta };
}) {
  const { t } = useTranslation();
  const key = session.key;
  const where = useAgentViewStore((s) =>
    leafShowing(s.root, key) !== null ? "shown" : leafHolding(s.root, key) ? "held" : null,
  );
  const duration = useDurationLabel(session.since);
  const managers = useManagerStore((s) => s.tasks[key] !== undefined);
  const run = activity.get(key);
  const facts =
    session.kind === "terminal"
      ? hookRowFacts(run)
      : chat
        ? chatRowFacts(chat.model, run)
        : hookRowFacts(undefined);
  const show = () => showInAgentView(session.workspaceId, session.tabId);
  const hover = (on: boolean) => useAgentViewStore.getState().setHovered(on ? key : null);
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for the row's own drag; the keyboard reaches its button
    <div
      className={cn(
        "relative rounded-(--radius-raised) border px-2 py-1.5 text-app-ui-sm transition-colors",
        session.phase === "attention"
          ? "border-(--state-warning-fg)/40 bg-(--state-warning-fg)/5 hover:bg-[var(--state-hover-bg)]"
          : "border-transparent hover:bg-[var(--state-hover-bg)]",
      )}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      onDragOver={(e) => {
        const edge = onReorder ? dropEdgeOf(e, session) : null;
        if (!edge) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (edge !== dropEdge) setDropEdge(edge);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropEdge(null);
      }}
      onDrop={(e) => {
        const moved = listDrag();
        const edge = onReorder ? dropEdgeOf(e, session) : null;
        setDropEdge(null);
        if (!moved || !edge || !onReorder) return;
        e.preventDefault();
        onReorder(moved, key, edge);
      }}
      data-testid="agent-sidebar-item"
      data-session-key={key}
    >
      {dropEdge && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-[var(--state-selected-indicator)]",
            dropEdge === "before" ? "-top-px" : "-bottom-px",
          )}
          data-testid="agent-sidebar-drop"
        />
      )}
      {/* The row as one button behind its content, so the subagents' buttons stay buttons. */}
      <button
        type="button"
        draggable
        aria-label={session.title}
        onClick={show}
        data-agent-row=""
        onDragStart={(e) => {
          setAgentDrag(e.dataTransfer, key);
          setListDrag(key);
        }}
        onDragEnd={() => setListDrag(null)}
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
            {duration && (
              <span
                className={cn(
                  "text-app-micro tabular-nums",
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
          {where && (
            <span
              role="img"
              aria-label={t(where === "shown" ? "agentView.list.shown" : "agentView.list.held")}
              title={t(where === "shown" ? "agentView.list.shown" : "agentView.list.held")}
              className="inline-flex shrink-0"
            >
              <Eye
                aria-hidden
                className={cn(
                  "size-3.5",
                  where === "shown"
                    ? "text-[var(--state-selected-indicator)]"
                    : "text-muted-foreground/60",
                )}
              />
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pl-5.5 text-app-micro">
          {placed && <WorkspaceTag workspace={placed.workspace} root={placed.root} />}
          {managers && <ManagerChip />}
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
}

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
        style={{ background: workspaceColor(root.id) }}
      />
      <span className="min-w-0 truncate">{workspace.name}</span>
    </span>
  );
}
