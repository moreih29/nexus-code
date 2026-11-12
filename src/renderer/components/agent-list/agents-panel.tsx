// Agent list — the files panel's agents view: a workspace's conversations
// and its tasks, with a header to find them, switch the view and start a
// conversation or a task. Each conversation is a tab, so picking its row
// shows that tab, and the row of the tab shown is the one marked; an agent
// a conversation runs has no tab, and opens its card beside the list.
//
// The view is the workspace's own when it was switched, else the default
// from Settings (state/stores/agent-list-view.ts). The header takes two
// lines; narrow, its buttons and the rows drop what can be told on hover.

import { ChevronDown, GitBranch, GitBranchPlus, List, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentListView } from "../../../shared/agent-list/view";
import {
  type ChatAgent,
  chatAgentOf,
  DEFAULT_TASK_AGENT,
} from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { newTask, revealInWorkspace } from "../../services/agent-sessions/actions";
import { findAgent } from "../../services/agent-sessions/agents";
import { allSessions, type SessionFamily, sessionKey } from "../../services/agent-sessions/model";
import {
  useSessionActivity,
  useSessionFamily,
  useTerminalWaits,
  useWorktreeChanges,
} from "../../services/agent-sessions/use-family";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { useActiveStore } from "../../state/stores/active";
import { selectAgentListView, useAgentListViewStore } from "../../state/stores/agent-list-view";
import { resolveWorkspaceProfile, useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { findLeaf } from "../../state/stores/layout/helpers";
import { useLayoutStore } from "../../state/stores/layout/store";
import { useTerminalStore } from "../../state/stores/terminal";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { NewChatMenuItems } from "../agent-profiles/new-chat-menu";
import { hasProfileChoice, ProfileDot, profileName } from "../agent-profiles/profile-badge";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { Button } from "../ui/button";
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { AgentPeek } from "./agent-peek";
import type { AgentListSelection } from "./selection";
import { StatusView } from "./status-view";
import { TaskView } from "./task-view";

/** The agent whose card is open, with the row it was opened from. */
interface Peek {
  readonly key: string;
  readonly agentId: string;
  readonly anchor: HTMLElement;
}

export function AgentsPanel({ workspace }: { workspace: WorkspaceMeta }) {
  const { t } = useTranslation();
  // Read only while shown: the files panel keeps one view at a time.
  const family = useSessionFamily(workspace.id, true);
  const ids = useMemo(() => family?.worktrees.map((w) => w.workspace.id) ?? [], [family]);
  const changes = useWorktreeChanges(ids, true);
  const activity = useSessionActivity(ids, true);
  const rootId = family?.root.id ?? workspace.id;
  const view = useAgentListViewStore((s) => selectAgentListView(s, rootId));
  // The task view tells which terminal waits on which.
  const waits = useTerminalWaits(view === "task");
  const [query, setQuery] = useState("");
  const [peek, setPeek] = useState<Peek | null>(null);
  const shownTab = useShownTabKey();

  if (!family) return null;

  const peeked = peek && findPeeked(family, peek);
  const agent = peeked && findAgent(activity, peeked.session.key, peek.agentId);
  // The card's agent is marked while it is open, else the tab shown.
  const selection: AgentListSelection | null =
    peek && agent
      ? { kind: "agent", key: peek.key, agentId: peek.agentId }
      : shownTab
        ? { kind: "session", key: shownTab }
        : null;

  const select = (next: AgentListSelection, from: HTMLElement) => {
    if (next.kind === "agent") {
      setPeek({ key: next.key, agentId: next.agentId, anchor: from });
      return;
    }
    setPeek(null);
    const session = allSessions(family).find((s) => s.key === next.key);
    if (session) revealInWorkspace(session);
  };

  return (
    <div className="@container/agents flex min-h-0 flex-1 flex-col" data-testid="agent-list-panel">
      <div className="flex flex-col gap-2 border-b border-border/50 px-2 py-2">
        <SearchBox query={query} onQuery={setQuery} />
        <div className="flex items-center gap-1">
          <ViewSwitch view={view} rootId={rootId} />
          <NewChat workspace={family.root} />
          <Button
            size="icon-sm"
            variant="outline"
            className="@max-[200px]/agents:w-7"
            title={t("task.new")}
            aria-label={t("task.new")}
            onClick={() => newTask(rootId)}
          >
            <GitBranchPlus aria-hidden className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="app-scrollbar min-h-0 flex-1 overflow-auto">
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
      {peek && peeked && agent && (
        <AgentPeek
          key={`${peek.key}:${peek.agentId}`}
          anchor={peek.anchor}
          worktree={peeked.worktree}
          session={peeked.session}
          agent={agent}
          asks={(activity.get(peek.key)?.asks ?? []).filter((ask) => ask.agentId === agent.id)}
          onShowSession={() => select({ kind: "session", key: peek.key }, peek.anchor)}
          onClose={() => setPeek(null)}
        />
      )}
    </div>
  );
}

/** The session key of the tab shown in the active workspace's active group, if any. */
function useShownTabKey(): string | null {
  const workspaceId = useActiveStore((s) => s.activeWorkspaceId);
  return useLayoutStore((s) => {
    const layout = workspaceId ? s.byWorkspace[workspaceId] : undefined;
    if (!workspaceId || !layout) return null;
    const tabId = findLeaf(layout.root, layout.activeGroupId)?.activeTabId;
    return tabId ? sessionKey(workspaceId, tabId) : null;
  });
}

/** The peeked agent's conversation and worktree, while the family has them. */
function findPeeked(family: SessionFamily, peek: Peek) {
  for (const worktree of family.worktrees) {
    const session = worktree.sessions.find((each) => each.key === peek.key);
    if (session) return { worktree, session };
  }
  return undefined;
}

/** Finds conversations by their title, last prompt or last answer; Esc clears it. */
function SearchBox({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-(--radius-control) border border-border bg-background px-2 focus-within:border-ring">
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
 * the workspace gives it, and tells both, but for [+] alone where the panel
 * is narrow. The menu is the tab bar's: either agent, or one with another
 * profile.
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
    <div className="ml-auto flex">
      <Button
        size="icon-sm"
        className="w-auto gap-1 rounded-r-none px-2 @max-[200px]/agents:px-1.5"
        title={title}
        aria-label={title}
        onClick={() => open(agent)}
        data-testid="agent-list-new-chat"
        data-agent={agent}
      >
        <Plus aria-hidden className="size-3.5" />
        <Icon aria-hidden className="size-3.5 @max-[200px]/agents:hidden" />
        {profile && <ProfileDot color={profile.color} className="@max-[200px]/agents:hidden" />}
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
