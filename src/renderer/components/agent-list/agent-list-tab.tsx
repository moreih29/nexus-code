// Agent list — a workspace's conversations and its tasks in one place: a
// header to find them, switch the view and start a conversation or a task,
// the list by state or by task, and the detail panel of the chosen one.
//
// The view is the workspace's own when it was switched, else the default
// from Settings (state/stores/agent-list-view.ts). Data is read only while
// the tab is shown. Where the tab is narrow, the detail takes the list's
// place until closed.

import { ChevronDown, GitBranch, GitBranchPlus, List, Plus, Search } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentListView } from "../../../shared/agent-list/view";
import {
  type ChatAgent,
  chatAgentOf,
  DEFAULT_TASK_AGENT,
} from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { newTask } from "../../services/agent-sessions/actions";
import { findAgent } from "../../services/agent-sessions/agents";
import type { InboxItem } from "../../services/agent-sessions/inbox";
import type { SessionFamily } from "../../services/agent-sessions/model";
import {
  useSessionActivity,
  useSessionFamily,
  useTerminalWaits,
  useWorktreeChanges,
} from "../../services/agent-sessions/use-family";
import { markRead } from "../../services/agent-sessions/use-inbox";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { selectAgentListView, useAgentListViewStore } from "../../state/stores/agent-list-view";
import { resolveWorkspaceProfile, useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useAppFocusStore } from "../../state/stores/app-focus";
import { useTerminalStore } from "../../state/stores/terminal";
import { AGENT_LIST_RATIO_MAX, AGENT_LIST_RATIO_MIN, useUIStore } from "../../state/stores/ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { NewChatMenuItems } from "../agent-profiles/new-chat-menu";
import { hasProfileChoice, ProfileDot, profileName } from "../agent-profiles/profile-badge";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { Button } from "../ui/button";
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { ResizeHandle } from "../ui/resize-handle";
import { type AgentListSelection, resolveSelection } from "./selection";
import { SessionDetail } from "./session-detail";
import { StatusView } from "./status-view";
import { TaskView } from "./task-view";

interface AgentListTabViewProps {
  workspaceId: string;
  isVisible: boolean;
}

export function AgentListTabView({ workspaceId, isVisible }: AgentListTabViewProps) {
  const { t } = useTranslation();
  const family = useSessionFamily(workspaceId, isVisible);
  const ids = useMemo(() => family?.worktrees.map((w) => w.workspace.id) ?? [], [family]);
  const changes = useWorktreeChanges(ids, isVisible);
  const activity = useSessionActivity(ids, isVisible);
  const rootId = family?.root.id ?? workspaceId;
  const view = useAgentListViewStore((s) => selectAgentListView(s, rootId));

  const listRatio = useUIStore((s) => s.agentListRatio);
  const setListRatio = useUIStore((s) => s.setAgentListRatio);
  const [splitWidth, splitRef] = useWidth();

  const [picked, setPicked] = useState<AgentListSelection | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selection = family
    ? resolveSelection(
        family,
        picked,
        (key, agentId) => findAgent(activity, key, agentId) !== undefined,
      )
    : null;
  // The task view and a task's detail tell which terminal waits on which.
  const waits = useTerminalWaits(isVisible && (view === "task" || selection?.kind === "worktree"));
  // A done conversation the user picks and reads here is read, as it is in
  // its own tab: not one shown first by itself, nor while the window is away.
  const [readKey, setReadKey] = useState<string | null>(null);
  const focused = useAppFocusStore((s) => s.focused);
  const reading =
    family && selection?.kind === "session" && selection.key === readKey && isVisible && focused
      ? findSession(family, selection.key)
      : undefined;
  // Once for each result it reads, not on each render while it shows.
  const doneKey =
    reading?.session.phase === "done"
      ? `${reading.session.key}@${reading.session.since ?? ""}`
      : null;
  const readingRef = useRef(reading);
  readingRef.current = reading;
  useEffect(() => {
    if (doneKey !== null && readingRef.current) markRead([readingRef.current]);
  }, [doneKey]);

  // Keep what was shown first, so the panel doesn't jump as states change;
  // move on only when it is gone, and then back to the list where narrow.
  const selectionKey = selection && keyOf(selection);
  useEffect(() => {
    if (!selection || (picked !== null && keyOf(picked) === selectionKey)) return;
    if (picked !== null) setDetailOpen(false);
    setPicked(selection);
  }, [selection, selectionKey, picked]);

  if (!family || !selection) return null;

  // The list's width: the share its divider was dragged to, else the default.
  const listWidth = listRatio === null ? DEFAULT_LIST_WIDTH : `${listRatio * 100}%`;
  const listPx = listRatio === null ? Math.min(480, splitWidth / 2) : listRatio * splitWidth;

  const select = (next: AgentListSelection) => {
    setPicked(next);
    setDetailOpen(true);
    setReadKey(next.kind === "session" ? next.key : null);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SearchBox query={query} onQuery={setQuery} />
        <ViewSwitch view={view} rootId={rootId} />
        <NewChat workspace={family.root} />
        <Button
          size="icon-sm"
          variant="outline"
          title={t("task.new")}
          aria-label={t("task.new")}
          onClick={() => newTask(rootId)}
        >
          <GitBranchPlus aria-hidden className="size-3.5" />
        </Button>
      </div>
      <div ref={splitRef} className="@container/agents flex min-h-0 flex-1">
        <div
          className={cn(
            "relative w-(--agents-list-width) shrink-0 border-r border-border",
            "@max-2xl/agents:w-full @max-2xl/agents:border-r-0",
            detailOpen && "@max-2xl/agents:hidden",
          )}
          style={{ "--agents-list-width": listWidth } as CSSProperties}
        >
          <div className="app-scrollbar absolute inset-0 overflow-auto">
            {view === "task" ? (
              <TaskView
                family={family}
                changes={changes}
                activity={activity}
                waits={waits}
                selection={selection}
                onSelect={select}
                query={query}
              />
            ) : (
              <StatusView
                family={family}
                changes={changes}
                activity={activity}
                selection={selection}
                onSelect={select}
                query={query}
              />
            )}
          </div>
          {/* Dragged to the share the user wants; double-click for the default.
              Narrow, the list and the detail take turns, with nothing to divide. */}
          <ResizeHandle
            value={Math.round(listPx)}
            min={Math.round(splitWidth * AGENT_LIST_RATIO_MIN)}
            max={Math.round(splitWidth * AGENT_LIST_RATIO_MAX)}
            placement="rightInside"
            className="z-10 @max-2xl/agents:hidden"
            ariaLabel={t("resize.agent_list")}
            onResize={(px, persist) => {
              if (splitWidth > 0) setListRatio(px / splitWidth, persist);
            }}
            onReset={() => setListRatio(null, true)}
          />
        </div>
        <div className={cn("min-w-0 flex-1", !detailOpen && "@max-2xl/agents:hidden")}>
          <SessionDetail
            family={family}
            selection={selection}
            changes={changes}
            activity={activity}
            waits={waits}
            visible={isVisible}
            onSelect={select}
            onBack={() => setDetailOpen(false)}
          />
        </div>
      </div>
    </div>
  );
}

/** The list's width until its divider is dragged. */
const DEFAULT_LIST_WIDTH = "min(480px, 50%)";

/**
 * The width of the element the returned ref is set on, kept current as it
 * is resized; 0 until it is in the document.
 */
function useWidth(): [number, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [width, setEl];
}

/** The session `key` names in the family, with its workspace. */
function findSession(family: SessionFamily, key: string): InboxItem | undefined {
  for (const { workspace, sessions } of family.worktrees) {
    const session = sessions.find((each) => each.key === key);
    if (session) return { workspace, session };
  }
  return undefined;
}

function keyOf(selection: AgentListSelection): string {
  switch (selection.kind) {
    case "session":
      return selection.key;
    case "agent":
      return `agent:${selection.key}:${selection.agentId}`;
    case "worktree":
      return `worktree:${selection.workspaceId}`;
  }
}

/** Finds conversations by their title, last prompt or last answer; Esc clears it. */
function SearchBox({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-control) border border-border bg-background px-2 focus-within:border-ring">
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query !== "") {
            event.preventDefault();
            onQuery("");
          }
        }}
        aria-label={t("agentList.list.search")}
        placeholder={t("agentList.list.search")}
        className="min-w-0 flex-1 bg-transparent text-app-ui-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}

const VIEW_ICONS: Record<AgentListView, typeof List> = { status: List, task: GitBranch };

/** The list by state or by task, as two icon buttons. */
function ViewSwitch({ view, rootId }: { view: AgentListView; rootId: string }) {
  const { t } = useTranslation();
  return (
    <fieldset
      aria-label={t("agentList.view_label")}
      className="flex shrink-0 items-center gap-0.5 rounded-(--radius-control) border border-border p-0.5"
    >
      {(["status", "task"] as const).map((each) => {
        const Icon = VIEW_ICONS[each];
        const label = t(`agentList.view.${each}`);
        return (
          <button
            key={each}
            type="button"
            aria-pressed={view === each}
            title={label}
            aria-label={label}
            onClick={() => useAgentListViewStore.getState().setForWorkspace(rootId, each)}
            className={cn(
              "flex size-6 items-center justify-center rounded-[calc(var(--radius-control)-2px)] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
              view === each
                ? "bg-[var(--sidebar-item-selected-bg)] text-foreground"
                : "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-3.5" />
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * A new conversation in the workspace. [+] opens one with the default agent
 * (Settings' "Default agent"; Claude when that is a terminal) and the profile
 * the workspace gives it, and tells both. The menu is the tab bar's: either
 * agent, or one with another profile.
 */
function NewChat({ workspace }: { workspace: WorkspaceMeta }) {
  const { t } = useTranslation();
  const agent = chatAgentOf(useTerminalStore((s) => s.taskAgent ?? DEFAULT_TASK_AGENT));
  const config = useAgentProfilesStore((s) => s.config);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  // Its profile is told only when there is another to choose, as the tab bar's is.
  const profile = useMemo(
    () =>
      hasProfileChoice(config, agent)
        ? resolveWorkspaceProfile(agent, workspace, workspaces, config).profile
        : null,
    [config, agent, workspace, workspaces],
  );
  const open = (chat: ChatAgent, profileId?: string) => {
    const props = { cwd: workspace.rootPath, ...(profileId ? { profileId } : {}) };
    if (chat === "claude") openClaudeTab(workspace.id, props);
    else openCodexTab(workspace.id, props);
  };
  const Icon = agent === "claude" ? ClaudeIcon : CodexIcon;
  const label = t(agent === "claude" ? "tabBar.new_claude" : "tabBar.new_codex");
  const title = profile ? `${label} · ${profileName(profile, t)}` : label;
  return (
    <div className="flex">
      <Button
        size="icon-sm"
        className="w-auto gap-1 rounded-r-none px-2"
        title={title}
        aria-label={title}
        onClick={() => open(agent)}
        data-testid="agent-list-new-chat"
        data-agent={agent}
      >
        <Plus aria-hidden className="size-3.5" />
        <Icon aria-hidden className="size-3.5" />
        {profile && <ProfileDot color={profile.color} />}
      </Button>
      <DropdownMenuRoot>
        <DropdownMenuTrigger>
          <Button
            size="icon-sm"
            className="w-6 rounded-l-none border-l border-primary-foreground/25"
            aria-label={t("agentList.list.new_chat")}
            title={t("agentList.list.new_chat")}
          >
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <NewChatMenuItems
            workspaceId={workspace.id}
            agent="claude"
            onOpen={(profileId) => open("claude", profileId)}
          />
          <NewChatMenuItems
            workspaceId={workspace.id}
            agent="codex"
            onOpen={(profileId) => open("codex", profileId)}
          />
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}
