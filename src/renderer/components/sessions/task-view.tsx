// Agents tab — the task view: one group per worktree (the workspace, then
// its tasks), each headed by its branch, the conversation that made it and
// its uncommitted changes, with its conversations in compact rows. A row
// says what its conversation waits on or runs, and which terminal it waits
// to end. The header picks the worktree for the detail panel.

import {
  CornerDownRight,
  FileDiff,
  Folder,
  GitBranch,
  Hourglass,
  ListTodo,
  MessageCircleQuestion,
  Shield,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { TerminalWait } from "../../../shared/sessions/agent-state";
import { chatKey, useChatStore } from "../../services/chat/store";
import type { ActivityByKey } from "../../services/sessions/agents";
import {
  type AgentSession,
  allSessions,
  type SessionFamily,
  sessionKey,
  type WorktreeEntry,
} from "../../services/sessions/model";
import {
  chatRowFacts,
  groupOf,
  hookRowFacts,
  matchesQuery,
  type RowFacts,
  sessionsByGroup,
  waitedOn,
} from "../../services/sessions/rows";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import type { SessionsSelection } from "./selection";
import { StateGlyph, stateColor, stateLabel, useDurationLabel } from "./session-status";
import { AgentMark, ToolIcon } from "./status-view";

interface TaskViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  waits: readonly TerminalWait[];
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
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
  const sessions = allSessions(family);
  const groups = family.worktrees
    .map((worktree) => ({ worktree, rows: sessionsByGroup(worktree.sessions, query) }))
    // A search keeps the worktrees with a conversation it found, or whose name it is.
    .filter(({ worktree }) => worktreeMatches(worktree, query));
  if (groups.length === 0) {
    return (
      <p className="p-4 text-app-ui-sm text-muted-foreground">{t("sessions.list.no_match")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-2" data-testid="sessions-task-view">
      {groups.map(({ worktree, rows }) => {
        const id = worktree.workspace.id;
        const createdBy = worktree.workspace.task?.createdBy;
        const creator = createdBy
          ? sessions.find((s) => s.key === sessionKey(createdBy.workspaceId, createdBy.tabId))
          : undefined;
        const selected = selection?.kind === "worktree" && selection.workspaceId === id;
        return (
          <section
            key={id}
            aria-label={worktreeName(worktree, changes.get(id)?.branch)}
            className={cn(
              "overflow-hidden rounded-(--radius-raised) border",
              selected ? "border-[var(--state-selected-indicator)]" : "border-border",
            )}
          >
            <TaskHeader
              worktree={worktree}
              branch={worktree.branch ?? changes.get(id)?.branch}
              creator={creator}
              changed={changes.get(id)?.files.length ?? 0}
              selected={selected}
              onSelect={() => onSelect({ kind: "worktree", workspaceId: id })}
            />
            {rows.length === 0 ? (
              <p className="border-t border-border px-3 py-1.5 text-app-ui-sm text-muted-foreground">
                {t("sessions.task.no_conversations")}
              </p>
            ) : (
              <ul>
                {rows.map((session) => (
                  <li key={session.key} className="border-t border-border">
                    <TaskRow
                      session={session}
                      activity={activity}
                      waitingOn={waitedOn(session, waits, sessions)}
                      selected={
                        (selection?.kind === "session" || selection?.kind === "agent") &&
                        selection.key === session.key
                      }
                      onSelect={() => onSelect({ kind: "session", key: session.key })}
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

function TaskHeader({
  worktree,
  branch,
  creator,
  changed,
  selected,
  onSelect,
}: {
  worktree: WorktreeEntry;
  branch: string | undefined;
  /** The conversation that made the task, while it is open. */
  creator: AgentSession | undefined;
  changed: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-app-ui-sm transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
        selected ? "bg-[var(--sidebar-item-selected-bg)]" : "hover:bg-[var(--state-hover-bg)]",
      )}
    >
      <WorktreeMark worktree={worktree} />
      <span className="min-w-0 truncate font-medium text-foreground">
        {worktreeName(worktree, branch)}
      </span>
      {worktree.isRoot && branch && (
        <span
          className="flex min-w-0 shrink items-center gap-1 rounded-(--radius-control) bg-muted px-1.5 font-mono text-app-micro text-muted-foreground"
          title={branch}
        >
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      {creator && (
        <span
          className="flex min-w-0 shrink items-center gap-1 text-app-micro text-muted-foreground"
          title={t("sessions.task.created_by", { title: creator.title })}
        >
          <CornerDownRight aria-hidden className="size-3 shrink-0" />
          <AgentMark session={creator} className="size-3" />
          <span className="truncate">{creator.title}</span>
        </span>
      )}
      {changed > 0 && (
        <span
          className="ml-auto flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums"
          title={t("sessions.detail.changes", { count: changed })}
        >
          <FileDiff aria-hidden className="size-3.5" />
          {changed}
        </span>
      )}
    </button>
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
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const chat = useChatStore((s) => s.tabs[chatKey(session.workspaceId, session.tabId)]);
  const facts =
    session.kind === "terminal"
      ? hookRowFacts(activity.get(session.key))
      : chat
        ? chatRowFacts(chat.model)
        : hookRowFacts(undefined);
  const duration = useDurationLabel(session.since);
  const group = groupOf(session);
  const ended = group === "ended" || group === "idle";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-app-ui-sm transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
        selected ? "bg-[var(--sidebar-item-selected-bg)]" : "hover:bg-[var(--state-hover-bg)]",
      )}
      data-testid="sessions-task-row"
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
          title={t("sessions.task.waiting_on", { title: waitingOn.title })}
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
