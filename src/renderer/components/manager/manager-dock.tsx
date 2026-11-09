// The agent manager's dock, at the right of the panels in either view: the
// sessions it handed work to, and its conversation. Shut, the manager goes
// on running; off, the dock offers to turn it on.

import { ChevronRight, LoaderCircle, MessageSquarePlus, Settings, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { profileOf } from "../../../shared/agent-profiles/profiles";
import { managerProfileOf } from "../../../shared/manager/manager";
import { MANAGER_PROMPT } from "../../../shared/manager/prompt";
import {
  managerClaudeHooks,
  managerCodexHooks,
  newManagerConversation,
} from "../../services/manager/runtime";
import { useManagerTasks } from "../../services/manager/use-tasks";
import type { AgentSession } from "../../services/sessions/model";
import { goToSession } from "../../services/sessions/use-inbox";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import {
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDTH_MAX,
  DOCK_WIDTH_MIN,
  useManagerStore,
} from "../../state/stores/manager";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { hasProfileChoice, ProfileDot, profileName } from "../agent-profiles/profile-badge";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { ClaudeTabView } from "../chat/claude-tab";
import { CodexTabView } from "../chat/codex-tab";
import { StateGlyph, stateLabel } from "../sessions/session-status";
import { AgentMark } from "../sessions/status-view";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { ResizeHandle } from "../ui/resize-handle";
import { ManagerIcon } from "./manager-chip";

export function ManagerDock() {
  const { t } = useTranslation();
  const open = useManagerStore((s) => s.dockOpen);
  const width = useManagerStore((s) => s.dockWidth);
  if (!open) return null;

  return (
    // At most half the window's width, whatever it was given: the workspace keeps the rest.
    <div className="relative flex min-w-0 shrink-0" style={{ width, maxWidth: "50%" }}>
      <ResizeHandle
        value={width}
        min={DOCK_WIDTH_MIN}
        max={DOCK_WIDTH_MAX}
        placement="leftCentered"
        ariaLabel={t("manager.resize")}
        onResize={(next, persist) => useManagerStore.getState().setDockWidth(next, persist)}
        onReset={() => useManagerStore.getState().setDockWidth(DOCK_WIDTH_DEFAULT, true)}
      />
      <Dock />
    </div>
  );
}

/** The dock itself: its header, and the manager's tasks and conversation. */
function Dock() {
  const { t } = useTranslation();
  const enabled = useManagerStore((s) => s.enabled);
  const agent = useManagerStore((s) => s.agent);
  const live = useManagerStore((s) => s.live);
  const chosen = useManagerStore((s) => s.profiles[agent]);
  const config = useAgentProfilesStore((s) => s.config);
  const AgentIcon = agent === "codex" ? CodexIcon : ClaudeIcon;
  // The profile it runs with; before it starts, the one it will.
  const profile =
    live?.agent === agent
      ? profileOf(config, agent, live.profileId)
      : managerProfileOf(config, agent, chosen);

  return (
    <aside
      className="flex min-w-0 flex-1 flex-col overflow-hidden island-surface rounded-(--radius-island)"
      aria-label={t("manager.title")}
      data-testid="manager-dock"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <ManagerIcon className="size-4 text-[var(--state-selected-indicator)]" aria-hidden="true" />
        <span className="text-app-body-emphasis">{t("manager.title")}</span>
        {enabled && (
          <span className="flex items-center gap-1 rounded-full border border-border px-1.5 text-app-micro leading-4 text-muted-foreground">
            <AgentIcon className="size-3" aria-hidden="true" />
            {t(`common:task.agents.${agent}`)}
            {hasProfileChoice(config, agent) && (
              <span
                className="flex min-w-0 items-center gap-1 border-l border-border pl-1"
                data-testid="manager-profile"
              >
                <ProfileDot color={profile.color} className="size-1.5" />
                <span className="max-w-24 truncate">{profileName(profile, t)}</span>
              </span>
            )}
          </span>
        )}
        <div className="ml-auto" />
        {enabled && (
          <IconButton label={t("manager.new_conversation")} onClick={newManagerConversation}>
            <MessageSquarePlus className="size-3.5" aria-hidden="true" />
          </IconButton>
        )}
        <IconButton
          label={t("manager.settings")}
          onClick={() => useSettingsUIStore.getState().openSettingsAt("manager")}
        >
          <Settings className="size-3.5" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t("manager.close")}
          onClick={() => useManagerStore.getState().setDockOpen(false)}
        >
          <X className="size-3.5" aria-hidden="true" />
        </IconButton>
      </div>
      {enabled ? (
        <>
          <TaskList />
          <div className="relative flex min-h-0 flex-1 flex-col">
            {live?.agent === "claude" ? (
              <ClaudeTabView
                key={live.run}
                workspaceId={live.workspaceId}
                tabId={live.tabId}
                props={{ cwd: live.cwd }}
                isVisible
                hooks={managerClaudeHooks}
              />
            ) : live?.agent === "codex" ? (
              <CodexTabView
                key={live.run}
                workspaceId={live.workspaceId}
                tabId={live.tabId}
                props={{ cwd: live.cwd }}
                isVisible
                hooks={managerCodexHooks}
                developerInstructions={MANAGER_PROMPT}
                trusted
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-label={t("manager.starting")} />
              </div>
            )}
          </div>
        </>
      ) : (
        <Off />
      )}
    </aside>
  );
}

/** What the dock shows while the manager is off. */
function Off() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <ManagerIcon className="size-8 text-muted-foreground" aria-hidden="true" />
      <div className="text-app-body">{t("manager.off.title")}</div>
      <div className="text-app-ui-sm text-muted-foreground">{t("manager.off.description")}</div>
      <Button size="sm" onClick={() => useManagerStore.getState().setSettings({ enabled: true })}>
        {t("manager.off.enable")}
      </Button>
    </div>
  );
}

/** The sessions the manager handed work to, folded to a line. */
function TaskList() {
  const { t } = useTranslation();
  const tasks = useManagerTasks();
  const [open, setOpen] = useState(true);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  if (tasks.length === 0) return null;
  const waiting = tasks.filter((task) => task.phase === "attention").length;
  return (
    <div className="shrink-0 border-b border-border px-2 py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-(--radius-control) px-1 py-0.5 text-app-ui-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5", open && "rotate-90")} aria-hidden="true" />
        <span>{t("manager.tasks", { count: tasks.length })}</span>
        {waiting > 0 && (
          <span className="text-(--state-warning-fg)">
            {t("manager.tasks_waiting", { count: waiting })}
          </span>
        )}
      </button>
      {open && (
        <ul className="app-scrollbar max-h-40 overflow-y-auto pb-0.5">
          {tasks.map((task) => (
            <TaskRow
              key={task.key}
              session={task}
              workspace={workspaces.find((w) => w.id === task.workspaceId)?.name}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskRow({ session, workspace }: { session: AgentSession; workspace?: string }) {
  const label = stateLabel(session);
  return (
    <li>
      <button
        type="button"
        onClick={() => goToSession(session)}
        title={session.message ?? session.title}
        className="flex w-full min-w-0 items-center gap-2 rounded-(--radius-control) px-1.5 py-1 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
      >
        <AgentMark session={session} />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {workspace && (
          <span className="max-w-24 shrink-0 truncate text-app-micro text-muted-foreground">
            {workspace}
          </span>
        )}
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-app-micro",
            session.phase === "attention" ? "text-(--state-warning-fg)" : "text-muted-foreground",
          )}
        >
          <StateGlyph state={session.state} />
          {label}
        </span>
      </button>
    </li>
  );
}
