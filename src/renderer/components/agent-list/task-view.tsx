import {
  CornerDownRight,
  Ellipsis,
  FileDiff,
  Folder,
  GitBranch,
  Hourglass,
  MessageSquarePlus,
  SquareTerminal,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyTextViaIpc } from "@/utils/clipboard";
import { cn } from "@/utils/cn";
import type { TerminalWait } from "../../../shared/sessions/agent-state";
import {
  openWorktreeChat,
  openWorktreeTerminal,
  removeTask,
  showChanges,
} from "../../services/agent-sessions/actions";
import type { ActivityByKey } from "../../services/agent-sessions/agents";
import {
  type AgentSession,
  allSessions,
  type SessionFamily,
  sessionKey,
  type WorktreeEntry,
} from "../../services/agent-sessions/model";
import { chatRowFacts, groupOf, hookRowFacts, waitedOn } from "../../services/agent-sessions/rows";
import { searchSessionTree, sessionTree } from "../../services/agent-sessions/session-tree";
import type { WorktreeChanges } from "../../services/agent-sessions/use-family";
import { workspaceTrees } from "../../services/agent-view/sidebar-tree";
import { chatKey, useChatStore } from "../../services/chat/store";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useUIStore } from "../../state/stores/ui";
import { Button } from "../ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { AgentRows } from "./agent-rows";
import type { AgentListSelection } from "./selection";
import { PlaceTag } from "./session-row";
import { SessionSign, stateColor, useDurationLabel } from "./session-status";
import { FamilyFold, ParentCaption, SessionTreeBranch } from "./session-tree-rows";
import { AgentMark } from "./status-view";
import { TaskInfo } from "./task-info";
import { TaskHeaderAction, TaskHeaderLine, TaskRowLine } from "./task-row-line";

interface TaskViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  waits: readonly TerminalWait[];
  selection: AgentListSelection | null;
  onSelect: (selection: AgentListSelection, from: HTMLElement) => void;
  query: string;
}

export function TaskView({
  family,
  changes,
  activity,
  waits,
  selection,
  onSelect,
  query,
}: TaskViewProps) {
  const { t } = useTranslation();
  const unfolded = useUIStore((s) => s.agentListUnfoldedTasks);
  const folded = useAgentViewStore((s) => s.folded);
  const order = useAgentViewStore((s) => s.order);
  const sessions = useMemo(() => allSessions(family), [family]);
  const tree = useMemo(() => sessionTree(sessions), [sessions]);
  const roots = useMemo(() => searchSessionTree(tree, query), [tree, query]);
  const needle = query.trim().toLowerCase();
  const searching = needle !== "";
  const groups =
    workspaceTrees([family], roots, order, searching, (worktree) =>
      worktreeName(worktree, undefined).toLowerCase().includes(needle),
    )[0]?.worktrees ?? [];
  const base = changes.get(family.root.id)?.branch;
  const branchOf = new Map(family.worktrees.map(({ workspace, branch }) => [workspace.id, branch]));
  if (groups.length === 0) {
    return (
      <p className="p-4 text-app-ui-sm text-muted-foreground">{t("agentList.list.no_match")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-2" data-testid="agent-list-task-view">
      {groups.map(({ worktree, roots, hosted }) => {
        const id = worktree.workspace.id;
        const createdBy = worktree.workspace.task?.createdBy;
        const creator = createdBy
          ? sessions.find((s) => s.key === sessionKey(createdBy.workspaceId, createdBy.tabId))
          : undefined;
        const branch = worktree.branch ?? changes.get(id)?.branch;
        const open = unfolded.has(id);
        return (
          <section
            key={id}
            aria-label={worktreeName(worktree, changes.get(id)?.branch)}
            className="overflow-hidden rounded-(--radius-raised) border border-border"
          >
            <TaskHeader
              worktree={worktree}
              branch={branch}
              creator={creator}
              changed={changes.get(id)?.files.length ?? 0}
              unfolded={open}
              onToggle={() => useUIStore.getState().toggleAgentListTask(id)}
            />
            {open && (
              <TaskInfo
                worktree={worktree}
                branch={branch}
                base={worktree.isRoot ? undefined : base}
                changes={changes.get(id)}
              />
            )}
            {roots.length === 0 && hosted === 0 && (
              <p className="border-t border-border px-3 py-1.5 text-app-ui-sm text-muted-foreground">
                {t("agentList.task.no_conversations")}
              </p>
            )}
            {roots.map((root) => (
              <SessionTreeBranch
                key={root.session.key}
                node={root}
                folded={folded}
                searching={searching}
                testPrefix="agent-list"
                renderRow={(node, collapsed) => {
                  const { session } = node;
                  return (
                    <div className="border-t border-border">
                      <TaskRow
                        session={session}
                        activity={activity}
                        waitingOn={waitedOn(session, waits, sessions)}
                        branch={
                          session.workspaceId === id ? undefined : branchOf.get(session.workspaceId)
                        }
                        parent={<ParentCaption node={node} />}
                        family={
                          node.count > 0 && (
                            <FamilyFold
                              session={session}
                              count={node.count}
                              collapsed={collapsed}
                              counts={node.counts}
                              testPrefix="agent-list"
                            />
                          )
                        }
                        selected={selection?.key === session.key}
                        onSelect={(from) => onSelect({ kind: "session", key: session.key }, from)}
                      />
                      <AgentRows
                        agents={activity.get(session.key)?.agents ?? []}
                        selectedId={
                          selection?.kind === "agent" && selection.key === session.key
                            ? selection.agentId
                            : undefined
                        }
                        onSelect={(agentId, from) =>
                          onSelect({ kind: "agent", key: session.key, agentId }, from)
                        }
                        className="pr-2 pb-1 pl-6"
                      />
                    </div>
                  );
                }}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

export function worktreeName(worktree: WorktreeEntry, branch: string | undefined): string {
  if (worktree.isRoot) return worktree.workspace.name;
  return worktree.branch ?? worktree.workspace.task?.branch ?? branch ?? worktree.workspace.name;
}

export function WorktreeMark({
  worktree,
  className,
}: {
  worktree: WorktreeEntry;
  className?: string;
}) {
  const Icon = worktree.isRoot ? Folder : GitBranch;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

function TaskHeader({
  worktree,
  branch,
  creator,
  changed,
  unfolded,
  onToggle,
}: {
  worktree: WorktreeEntry;
  branch: string | undefined;
  creator: AgentSession | undefined;
  changed: number;
  unfolded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { workspace } = worktree;
  const name = worktreeName(worktree, branch);
  const path = workspace.task?.worktreePath ?? workspace.rootPath;
  return (
    <TaskHeaderLine
      name={name}
      isRoot={worktree.isRoot}
      branch={branch}
      creator={
        creator && (
          <span
            className="flex min-w-0 shrink items-center gap-1 text-app-micro text-muted-foreground @max-xs/agents:hidden"
            title={t("agentList.task.created_by", { title: creator.title })}
          >
            <CornerDownRight aria-hidden className="size-3 shrink-0" />
            <AgentMark session={creator} className="size-3" />
            <span className="truncate">{creator.title}</span>
          </span>
        )
      }
      changed={changed}
      unfolded={unfolded}
      onToggle={onToggle}
      menuOpen={menuOpen}
      testId="agent-list-task-header"
      actions={
        <>
          <TaskHeaderAction
            label={t("agentList.detail.show_changes")}
            onClick={() => showChanges(workspace.id)}
          >
            <FileDiff aria-hidden className="size-3.5" />
          </TaskHeaderAction>
          <TaskHeaderAction
            label={t("agentList.task.open_terminal")}
            onClick={() => openWorktreeTerminal(workspace)}
          >
            <SquareTerminal aria-hidden className="size-3.5" />
          </TaskHeaderAction>
          <TaskHeaderAction
            label={t("agentList.list.new_claude")}
            onClick={() => openWorktreeChat(workspace)}
          >
            <MessageSquarePlus aria-hidden className="size-3.5" />
          </TaskHeaderAction>
          <DropdownMenuRoot onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger>
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-6"
                title={t("agentList.task.more")}
                aria-label={t("agentList.task.more")}
              >
                <Ellipsis aria-hidden className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void copyTextViaIpc(path)}>
                {t("agentList.task.copy_path")}
              </DropdownMenuItem>
              {!worktree.isRoot && (
                <DropdownMenuItem
                  className="text-(--state-error-fg)"
                  onSelect={() => removeTask(workspace.id)}
                >
                  {t("agentList.detail.remove_task")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenuRoot>
        </>
      }
    />
  );
}

export function TaskRow({
  session,
  activity,
  waitingOn,
  branch,
  parent,
  family,
  selected,
  onSelect,
}: {
  session: AgentSession;
  activity: ActivityByKey;
  waitingOn: AgentSession | undefined;
  branch?: string;
  parent?: ReactNode;
  family?: ReactNode;
  selected: boolean;
  onSelect: (from: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const chat = useChatStore((s) => s.tabs[chatKey(session.workspaceId, session.tabId)]);
  const facts =
    session.kind === "terminal"
      ? hookRowFacts(activity.get(session.key))
      : chat
        ? chatRowFacts(chat.model, activity.get(session.key))
        : hookRowFacts(undefined);
  const duration = useDurationLabel(session.since);
  const group = groupOf(session);
  const tool = session.phase === "running" ? facts.tool : undefined;
  return (
    <TaskRowLine
      mark={<AgentMark session={session} />}
      title={session.title}
      tooltip={tool ? `${session.title}\n${tool.name} ${tool.target ?? ""}`.trim() : session.title}
      emphasized={group === "attention" || group === "running" || group === "done"}
      tags={
        (branch || parent || waitingOn) && (
          <>
            {branch && (
              <PlaceTag place={{ kind: "branch", name: branch }} testId="agent-list-branch" />
            )}
            {parent}
            {waitingOn && (
              <span
                className="flex max-w-40 min-w-0 items-center gap-1"
                title={t("agentList.task.waiting_on", { title: waitingOn.title })}
              >
                <Hourglass aria-hidden className="size-3 shrink-0" />
                <AgentMark session={waitingOn} className="size-3" />
                <span className="truncate">{waitingOn.title}</span>
              </span>
            )}
          </>
        )
      }
      family={family}
      sign={<SessionSign session={session} facts={facts} />}
      duration={duration}
      durationClass={
        group === "attention" || group === "done"
          ? stateColor(session.state)
          : "text-muted-foreground"
      }
      selected={selected}
      aria-pressed={selected}
      onSelect={onSelect}
      testId="agent-list-task-row"
      sessionKey={session.key}
    />
  );
}
