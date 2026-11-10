// The agent view's list: every workspace's agents under it, a workspace's
// tasks set in below it, in the sidebar's order. A row shows its agent in
// a panel, by a click or dragged where it should go; the eye tells which
// already are, and the pointer on a row lights up the panel it is in.

import { ChevronDown, ChevronRight, Eye, GitBranch, Plus } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AGENT_FILTERS,
  type AgentFilter,
  agentCounts,
  passesFilter,
  workspaceColor,
} from "@/services/agent-view/agents";
import { leafHolding, leafShowing } from "@/services/agent-view/layout";
import { showInAgentView } from "@/services/agent-view/show";
import { useAgents } from "@/services/agent-view/use-agents";
import { type ChatTabState, chatKey, useChatStore } from "@/services/chat/store";
import type { ActivityByKey } from "@/services/sessions/agents";
import type { AgentSession, SessionFamily, WorktreeEntry } from "@/services/sessions/model";
import { chatRowFacts, hookRowFacts } from "@/services/sessions/rows";
import { useSessionActivity } from "@/services/sessions/use-family";
import { openClaudeTab, openCodexTab } from "@/state/operations/tabs";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { useManagerStore } from "@/state/stores/manager";
import { useUIStore } from "@/state/stores/ui";
import { selectWorkspaceConnectionStatus, useWorkspacesStore } from "@/state/stores/workspaces";
import { cn } from "@/utils/cn";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { NewChatMenuItems } from "../agent-profiles/new-chat-menu";
import { ManagerChip } from "../manager/manager-chip";
import { AgentRows } from "../sessions/agent-rows";
import { StateGlyph, stateLabel, useDurationLabel } from "../sessions/session-status";
import { AgentMark, RowLine } from "../sessions/status-view";
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { IconButton } from "../ui/icon-button";
import { connectionStatusClassName } from "../workbench/sidebar";
import { SidebarResizeHandle } from "../workbench/sidebar-resize-handle";
import { SystemStatsFooter } from "../workbench/system-stats";
import { setAgentDrag } from "./drag";

/** The state whose glyph stands for a filter. */
const FILTER_STATE: Record<Exclude<AgentFilter, "all">, string> = {
  running: "running",
  attention: "permissionPending",
  done: "completed",
  idle: "idle",
};

// Memo: kept while hidden, it would render again with each of the app's.
export const AgentSidebar = memo(function AgentSidebar() {
  const { t } = useTranslation();
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const agents = useAgents();
  const counts = agentCounts(agents);
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const ids = useMemo(
    () => agents.families.flatMap((family) => family.worktrees.map((w) => w.workspace.id)),
    [agents],
  );
  const activity = useSessionActivity(ids, true);
  const chats = useChatStore((s) => s.tabs);

  const families = agents.families
    .map((family) => ({
      family,
      worktrees: family.worktrees
        .map((worktree) => ({
          worktree,
          sessions: worktree.sessions.filter((session) => passesFilter(session, filter)),
        }))
        // A task shows with agents to list; the workspace itself always does
        // while nothing is filtered, for its + to start one.
        .filter(
          ({ worktree, sessions }) => sessions.length > 0 || (filter === "all" && worktree.isRoot),
        ),
    }))
    .filter(({ worktrees }) => worktrees.length > 0);

  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
          <fieldset aria-label={t("agentView.list.filter_aria")} className="flex flex-wrap gap-1">
            {AGENT_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-app-micro whitespace-nowrap transition-colors",
                  filter === value
                    ? "border-[var(--state-selected-indicator)] bg-[var(--sidebar-item-selected-bg)] text-foreground"
                    : "border-border text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
                )}
              >
                {value !== "all" && (
                  // A count of none has nothing running to spin for.
                  <StateGlyph state={FILTER_STATE[value]} still={counts[value] === 0} />
                )}
                <span>{t(`agentView.list.filter.${value}`)}</span>
                <span className="tabular-nums">{counts[value]}</span>
              </button>
            ))}
          </fieldset>
        </div>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {agents.families.length === 0 ? (
            <p className="px-2 py-4 text-center text-app-ui-sm text-muted-foreground whitespace-pre-line">
              {t("sidebar.no_workspaces")}
            </p>
          ) : families.length === 0 ? (
            <p className="px-2 py-4 text-center text-app-ui-sm text-muted-foreground">
              {t("agentView.list.none_filtered")}
            </p>
          ) : (
            families.map(({ family, worktrees }) => (
              <FamilyGroup
                key={family.root.id}
                family={family}
                worktrees={worktrees}
                folded={folded.has(family.root.id)}
                onToggle={() => toggleFold(family.root.id)}
                activity={activity}
                chats={chats}
                filtered={filter !== "all"}
              />
            ))
          )}
        </div>
        <SystemStatsFooter />
      </div>
      <SidebarResizeHandle />
    </aside>
  );
});

function FamilyGroup({
  family,
  worktrees,
  folded,
  onToggle,
  activity,
  chats,
  filtered,
}: {
  family: SessionFamily;
  worktrees: readonly { worktree: WorktreeEntry; sessions: readonly AgentSession[] }[];
  folded: boolean;
  onToggle: () => void;
  activity: ActivityByKey;
  chats: Record<string, ChatTabState>;
  filtered: boolean;
}) {
  const { t } = useTranslation();
  const root = family.root;
  const count = worktrees.reduce((n, { sessions }) => n + sessions.length, 0);
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
          {folded && count > 0 && (
            <span className="shrink-0 text-app-micro text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
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
              />
            ))}
            {worktree.isRoot && sessions.length === 0 && !filtered && (
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

function AgentItem({
  session,
  activity,
  chat,
}: {
  session: AgentSession;
  activity: ActivityByKey;
  chat: ChatTabState | undefined;
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
  return (
    <div
      className={cn(
        "relative rounded-(--radius-raised) border px-2 py-1.5 text-app-ui-sm transition-colors",
        session.phase === "attention"
          ? "border-(--state-warning-fg)/40 bg-(--state-warning-fg)/5 hover:bg-[var(--state-hover-bg)]"
          : "border-transparent hover:bg-[var(--state-hover-bg)]",
      )}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      data-testid="agent-sidebar-item"
      data-session-key={key}
    >
      {/* The row as one button behind its content, so the subagents' buttons stay buttons. */}
      <button
        type="button"
        draggable
        aria-label={session.title}
        onClick={show}
        onDragStart={(e) => setAgentDrag(e.dataTransfer, key)}
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
            <span
              role="img"
              aria-label={stateLabel(session)}
              title={stateLabel(session)}
              className="inline-flex"
              data-testid="agent-sidebar-state"
            >
              <StateGlyph state={session.state} />
            </span>
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
          {managers && <ManagerChip />}
          <RowLine session={session} facts={facts} />
        </div>
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
