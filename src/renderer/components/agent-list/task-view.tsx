// Agent list — the task view: one group per worktree (the workspace, then
// its tasks), each headed by its branch, the conversation that made it and
// its uncommitted changes, with its conversations in compact rows. A row
// says what its conversation waits on or runs, and which terminal it waits
// to end. The header unfolds the worktree's facts, and offers what can be
// done in it.

import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Ellipsis,
  FileDiff,
  Folder,
  GitBranch,
  Hourglass,
  ListTodo,
  MessageCircleQuestion,
  MessageSquarePlus,
  Shield,
  SquareTerminal,
} from "lucide-react";
import { useState } from "react";
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
import {
  chatRowFacts,
  groupOf,
  hookRowFacts,
  matchesQuery,
  type RowFacts,
  sessionsByGroup,
  waitedOn,
} from "../../services/agent-sessions/rows";
import type { WorktreeChanges } from "../../services/agent-sessions/use-family";
import { chatKey, useChatStore } from "../../services/chat/store";
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
import { StateGlyph, stateColor, stateLabel, useDurationLabel } from "./session-status";
import { AgentMark, ToolIcon } from "./status-view";
import { TaskInfo } from "./task-info";

interface TaskViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  waits: readonly TerminalWait[];
  selection: AgentListSelection | null;
  /** A conversation picked, or an agent, with the row it was picked from. */
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
  // The worktrees whose facts are unfolded, kept by the app as the status
  // view's folded groups are: folded until the user opens one.
  const unfolded = useUIStore((s) => s.agentListUnfoldedTasks);
  const sessions = allSessions(family);
  // A task is compared with its workspace's branch.
  const base = changes.get(family.root.id)?.branch;
  const groups = family.worktrees
    .map((worktree) => ({ worktree, rows: sessionsByGroup(worktree.sessions, query) }))
    // A search keeps the worktrees with a conversation it found, or whose name it is.
    .filter(({ worktree }) => worktreeMatches(worktree, query));
  if (groups.length === 0) {
    return (
      <p className="p-4 text-app-ui-sm text-muted-foreground">{t("agentList.list.no_match")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-2" data-testid="agent-list-task-view">
      {groups.map(({ worktree, rows }) => {
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
            {rows.length === 0 ? (
              <p className="border-t border-border px-3 py-1.5 text-app-ui-sm text-muted-foreground">
                {t("agentList.task.no_conversations")}
              </p>
            ) : (
              <ul>
                {rows.map((session) => (
                  <li key={session.key} className="border-t border-border">
                    <TaskRow
                      session={session}
                      activity={activity}
                      waitingOn={waitedOn(session, waits, sessions)}
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
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** A worktree's name: the workspace's own, or a task's branch. */
export function worktreeName(worktree: WorktreeEntry, branch: string | undefined): string {
  if (worktree.isRoot) return worktree.workspace.name;
  return worktree.branch ?? worktree.workspace.task?.branch ?? branch ?? worktree.workspace.name;
}

/** The worktree's mark: a folder for the workspace, a branch for a task. */
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

/**
 * A worktree's header: its name, the conversation that made it and its
 * changes, folding its facts open or shut. Under the pointer, or with the
 * keyboard in it, the changes give way to what can be done in it.
 */
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
  /** The conversation that made the task, while it is open. */
  creator: AgentSession | undefined;
  changed: number;
  unfolded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  // Its actions stay while their menu is open, which takes the pointer and the keyboard.
  const [menuOpen, setMenuOpen] = useState(false);
  const { workspace } = worktree;
  const name = worktreeName(worktree, branch);
  const path = workspace.task?.worktreePath ?? workspace.rootPath;
  const Chevron = unfolded ? ChevronDown : ChevronRight;
  return (
    <div
      className="group/task relative flex min-w-0 items-center gap-2 px-3 py-2 text-app-ui-sm transition-colors hover:bg-[var(--state-hover-bg)]"
      data-testid="agent-list-task-header"
    >
      {/* The header as one button behind its content, so its actions stay buttons. */}
      <button
        type="button"
        aria-expanded={unfolded}
        aria-label={name}
        onClick={onToggle}
        className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2">
        <Chevron aria-hidden className="-ml-1 size-3.5 shrink-0 text-muted-foreground" />
        <WorktreeMark worktree={worktree} />
        <span className="min-w-0 truncate font-medium text-foreground" title={name}>
          {name}
        </span>
        {worktree.isRoot && branch && (
          <span
            className="flex min-w-0 shrink items-center gap-1 rounded-(--radius-control) bg-muted px-1.5 font-mono text-app-micro text-muted-foreground @max-xs/agents:hidden"
            title={branch}
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        )}
        {creator && (
          <span
            className="flex min-w-0 shrink items-center gap-1 text-app-micro text-muted-foreground @max-xs/agents:hidden"
            title={t("agentList.task.created_by", { title: creator.title })}
          >
            <CornerDownRight aria-hidden className="size-3 shrink-0" />
            <AgentMark session={creator} className="size-3" />
            <span className="truncate">{creator.title}</span>
          </span>
        )}
      </div>
      {changed > 0 && (
        <span
          className={cn(
            "pointer-events-none relative flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums",
            menuOpen ? "hidden" : "group-focus-within/task:hidden group-hover/task:hidden",
          )}
          title={t("agentList.detail.changes", { count: changed })}
        >
          <FileDiff aria-hidden className="size-3.5" />
          {changed}
        </span>
      )}
      <div
        className={cn(
          "relative shrink-0 items-center gap-0.5",
          menuOpen ? "flex" : "hidden group-focus-within/task:flex group-hover/task:flex",
        )}
      >
        <HeaderAction
          label={t("agentList.detail.show_changes")}
          onClick={() => showChanges(workspace.id)}
        >
          <FileDiff aria-hidden className="size-3.5" />
        </HeaderAction>
        <HeaderAction
          label={t("agentList.task.open_terminal")}
          onClick={() => openWorktreeTerminal(workspace)}
        >
          <SquareTerminal aria-hidden className="size-3.5" />
        </HeaderAction>
        <HeaderAction
          label={t("agentList.list.new_claude")}
          onClick={() => openWorktreeChat(workspace)}
        >
          <MessageSquarePlus aria-hidden className="size-3.5" />
        </HeaderAction>
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
            <DropdownMenuItem onSelect={() => copyTextViaIpc(path)}>
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
      </div>
    </div>
  );
}

/** One of a worktree header's actions, as an icon with its name for a title. */
function HeaderAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="size-6"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * A conversation in a line: its state, its mark and title, what it waits
 * on or runs, and how long it has been so.
 */
export function TaskRow({
  session,
  activity,
  waitingOn,
  selected,
  onSelect,
}: {
  session: AgentSession;
  activity: ActivityByKey;
  /** The conversation its terminal waits to end. */
  waitingOn: AgentSession | undefined;
  selected: boolean;
  /** Picked, with its row. */
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
  const ended = group === "ended" || group === "idle";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={(event) => onSelect(event.currentTarget)}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-app-ui-sm transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
        selected ? "bg-[var(--sidebar-item-selected-bg)]" : "hover:bg-[var(--state-hover-bg)]",
      )}
      data-testid="agent-list-task-row"
    >
      <span className="flex w-3.5 shrink-0 justify-center" title={stateLabel(session)}>
        <StateGlyph state={session.state} />
      </span>
      <AgentMark session={session} />
      <span
        className={cn(
          "min-w-0 truncate",
          group === "attention" || group === "running" || group === "done"
            ? "font-medium text-foreground"
            : "text-foreground/90",
        )}
        title={session.title}
      >
        {session.title}
      </span>
      {waitingOn && (
        <span
          className="flex min-w-0 shrink items-center gap-1 text-app-micro text-muted-foreground"
          title={t("agentList.task.waiting_on", { title: waitingOn.title })}
        >
          <Hourglass aria-hidden className="size-3 shrink-0" />
          <AgentMark session={waitingOn} className="size-3" />
          <span className="truncate">{waitingOn.title}</span>
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <RowSign session={session} facts={facts} />
        {duration && (
          <span
            className={cn(
              "text-app-micro tabular-nums",
              group === "attention" || group === "done"
                ? stateColor(session.state)
                : "text-muted-foreground",
              ended && "text-muted-foreground",
            )}
          >
            {duration}
          </span>
        )}
      </span>
    </button>
  );
}

/** What the conversation waits on, or the kind of call it runs, as an icon. */
function RowSign({ session, facts }: { session: AgentSession; facts: RowFacts }) {
  const warn = "size-3.5 shrink-0 text-(--state-warning-fg)";
  const wait = facts.wait;
  if (wait?.kind === "question" || (!wait && session.state === "needsInput")) {
    return <MessageCircleQuestion aria-hidden className={warn} />;
  }
  if (wait?.kind === "plan") return <ListTodo aria-hidden className={warn} />;
  if (wait?.kind === "permission" || session.state === "permissionPending") {
    return <Shield aria-hidden className={warn} />;
  }
  if (session.phase === "running" && facts.tool) {
    return (
      <span title={facts.tool.target ? `${facts.tool.name} ${facts.tool.target}` : facts.tool.name}>
        <ToolIcon name={facts.tool.name} />
      </span>
    );
  }
  return null;
}

/** Whether the worktree or one of its conversations matches `query`. */
function worktreeMatches(worktree: WorktreeEntry, query: string): boolean {
  return (
    query.trim() === "" ||
    worktree.sessions.some((session) => matchesQuery(session, query)) ||
    worktreeName(worktree, undefined).toLowerCase().includes(query.trim().toLowerCase())
  );
}
