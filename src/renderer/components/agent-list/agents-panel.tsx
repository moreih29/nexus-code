import { ChevronDown, GitBranchPlus, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { SearchInput } from "../ui/search-input";
import { AgentPeek } from "./agent-peek";
import type { AgentListSelection } from "./selection";
import { StatusView } from "./status-view";
import { TaskView } from "./task-view";
import { ViewSwitch } from "./view-switch";

interface Peek {
  readonly key: string;
  readonly agentId: string;
  readonly anchor: HTMLElement;
}

export function AgentsPanel({ workspace }: { workspace: WorkspaceMeta }) {
  const { t } = useTranslation();
  const family = useSessionFamily(workspace.id, true);
  const ids = useMemo(() => family?.worktrees.map((w) => w.workspace.id) ?? [], [family]);
  const changes = useWorktreeChanges(ids, true);
  const activity = useSessionActivity(ids, true);
  const rootId = family?.root.id ?? workspace.id;
  const view = useAgentListViewStore((s) => selectAgentListView(s, rootId));
  const waits = useTerminalWaits(view === "task");
  const [query, setQuery] = useState("");
  const [peek, setPeek] = useState<Peek | null>(null);
  const shownTab = useShownTabKey();

  if (!family) return null;

  const peeked = peek && findPeeked(family, peek);
  const agent = peeked && findAgent(activity, peeked.session.key, peek.agentId);
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
        <SearchInput value={query} onChange={setQuery} label={t("agentList.list.search")} />
        <div className="flex items-center gap-1">
          <ViewSwitch
            view={view}
            onChange={(next) => useAgentListViewStore.getState().setForWorkspace(rootId, next)}
          />
          <NewChat workspace={family.root} />
          <Button
            size="icon-sm"
            variant="outline"
            className="@max-[200px]/agents:w-7"
            tooltip={t("task.new")}
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
          sessionId={activity.get(peek.key)?.sessionId}
          agent={agent}
          asks={(activity.get(peek.key)?.asks ?? []).filter((ask) => ask.agentId === agent.id)}
          onShowSession={() => select({ kind: "session", key: peek.key }, peek.anchor)}
          onClose={() => setPeek(null)}
        />
      )}
    </div>
  );
}

function useShownTabKey(): string | null {
  const workspaceId = useActiveStore((s) => s.activeWorkspaceId);
  return useLayoutStore((s) => {
    const layout = workspaceId ? s.byWorkspace[workspaceId] : undefined;
    if (!workspaceId || !layout) return null;
    const tabId = findLeaf(layout.root, layout.activeGroupId)?.activeTabId;
    return tabId ? sessionKey(workspaceId, tabId) : null;
  });
}

function findPeeked(family: SessionFamily, peek: Peek) {
  for (const worktree of family.worktrees) {
    const session = worktree.sessions.find((each) => each.key === peek.key);
    if (session) return { worktree, session };
  }
  return undefined;
}

function NewChat({ workspace }: { workspace: WorkspaceMeta }) {
  const { t } = useTranslation();
  const agent = chatAgentOf(useTerminalStore((s) => s.taskAgent ?? DEFAULT_TASK_AGENT));
  const config = useAgentProfilesStore((s) => s.config);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
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
        tooltip={title}
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
            tooltip={t("agentList.list.new_chat")}
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
