// Task switcher — the title bar's workspace name, as a menu of the
// workspace's tasks.
//
// The sidebar has one row per workspace; a workspace's tasks are switched
// here. The menu lists the workspace itself and its tasks, each with its
// branch, Claude glyph and the ports its terminals' programs listen on, then
// their sessions tab, New Task and, on a task, Delete This Task.

import { Check, ChevronDown, GitBranch } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { portsLabel } from "../../../shared/pty/ports";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { useCodexWorkspaceStatus } from "../../services/sessions/use-codex-status";
import { activateWorkspace } from "../../services/workspace/tasks";
import { openSessionsTab } from "../../state/operations/tabs";
import {
  selectWorkspaceAggregateStatus,
  useClaudeStatusStore,
  WORKSPACE_VISIBLE_STATUSES,
} from "../../state/stores/claude-status";
import { useGitStore } from "../../state/stores/git/index";
import { NO_PORTS, usePortsStore } from "../../state/stores/ports";
import { useTaskUIStore } from "../../state/stores/task-ui";
import { tasksOf, useWorkspacesStore } from "../../state/stores/workspaces";
import { WorkspaceStatusGlyph } from "../sidebar/workspace-status-glyph";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cardGlyph } from "./sidebar";

/** How many of a task's ports its menu item lists before "+N". */
const SHOWN_PORTS = 2;

interface TaskSwitcherProps {
  /** The active workspace: a workspace or one of its tasks. */
  active: WorkspaceMeta;
  /** The label of the task's workspace, e.g. with its SSH host. */
  label: (workspace: WorkspaceMeta) => string;
}

export function TaskSwitcher({ active, label }: TaskSwitcherProps) {
  const { t } = useTranslation();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const rootId = active.task?.parentId ?? active.id;
  const root = workspaces.find((w) => w.id === rootId) ?? active;
  const tasks = useMemo(() => tasksOf(workspaces, rootId), [workspaces, rootId]);
  const rootLabel = label(root);

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <button
          type="button"
          aria-label={t("task.switcher_aria")}
          title={rootLabel}
          className={cn(
            "app-no-drag absolute left-1/2 -translate-x-1/2 max-w-[40%]",
            "flex items-center gap-1.5 px-2 h-7 rounded-(--radius-control)",
            "text-app-body-emphasis text-foreground",
            "hover:bg-[var(--state-hover-bg)] data-[state=open]:bg-[var(--state-active-bg)]",
            "transition-colors duration-150",
          )}
        >
          <span className="truncate">{rootLabel}</span>
          {active.task && (
            <>
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{active.name}</span>
            </>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      {/* Its items run once the menu has closed, so the new and remove task
          dialogs take the keyboard and give it back to this button. */}
      <DropdownMenuContent align="center">
        <TaskItem workspace={root} active={active.id === root.id} />
        {tasks.map((task) => (
          <TaskItem key={task.id} workspace={task} active={active.id === task.id} />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSessionsTab(active.id)}>
          {t("task.show_sessions")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => useTaskUIStore.getState().openNewTask(root.id)}>
          {t("task.new")}
        </DropdownMenuItem>
        {active.task && (
          <DropdownMenuItem onSelect={() => useTaskUIStore.getState().openRemoveTask(active.id)}>
            {t("task.remove_current")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/** One workspace in the menu: a check when active, its name, glyph and branch. */
function TaskItem({ workspace, active }: { workspace: WorkspaceMeta; active: boolean }) {
  const { t } = useTranslation();
  const gitBranch = useGitStore((s) => {
    const session = s.sessions.get(workspace.id);
    return session?.branchInfo?.current ?? session?.status?.branch?.current ?? null;
  });
  const tabs = useClaudeStatusStore((s) => s.byWorkspace[workspace.id]);
  const status = useMemo(() => {
    if (tabs === undefined) return null;
    const aggregate = selectWorkspaceAggregateStatus(
      { byWorkspace: { [workspace.id]: tabs } } as Parameters<
        typeof selectWorkspaceAggregateStatus
      >[0],
      workspace.id,
    );
    return aggregate && WORKSPACE_VISIBLE_STATUSES.includes(aggregate.status)
      ? aggregate.status
      : null;
  }, [tabs, workspace.id]);
  const codexStatus = useCodexWorkspaceStatus([workspace.id]);
  const glyph = cardGlyph(status, null, codexStatus);
  const branch = gitBranch ?? workspace.task?.branch ?? null;
  const ports = usePortsStore((s) => s.byWorkspace[workspace.id] ?? NO_PORTS);

  return (
    <DropdownMenuItem onSelect={() => activateWorkspace(workspace.id)}>
      <span className="flex items-center gap-2 min-w-0">
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
          {active && <Check className="size-3.5" aria-hidden="true" />}
        </span>
        <span className="truncate max-w-[240px]">{workspace.name}</span>
        {glyph && <WorkspaceStatusGlyph status={glyph.status} codex={glyph.codex} />}
      </span>
      {branch && (
        <span className="ml-4 truncate max-w-[180px] text-muted-foreground">{branch}</span>
      )}
      {ports.length > 0 && (
        <span
          className="ml-3 shrink-0 tabular-nums text-muted-foreground"
          title={t("task.ports_title", { ports: portsLabel(ports, ports.length) })}
        >
          {portsLabel(ports, SHOWN_PORTS)}
        </span>
      )}
    </DropdownMenuItem>
  );
}
