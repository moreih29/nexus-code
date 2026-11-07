// Agents tab — the detail panel: a conversation's (conversation-detail.tsx),
// a terminal agent's (agent-detail.tsx), or a task's: its branch and folder,
// how far it has gone from its workspace's branch, its uncommitted changes in
// lines and its conversations, with the actions on it.

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  FileDiff,
  MessageSquarePlus,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { FileLineStats, GitChangeStats } from "../../../shared/git/types";
import type { TerminalWait } from "../../../shared/sessions/agent-state";
import {
  openWorktreeChat,
  openWorktreeTerminal,
  removeTask,
  showChanges,
} from "../../services/sessions/actions";
import { type ActivityByKey, findAgent } from "../../services/sessions/agents";
import { allSessions, type SessionFamily, type WorktreeEntry } from "../../services/sessions/model";
import { sessionsByGroup, waitedOn } from "../../services/sessions/rows";
import { useChangeStats, type WorktreeChanges } from "../../services/sessions/use-family";
import { Button } from "../ui/button";
import { AgentDetail } from "./agent-detail";
import { ConversationDetail } from "./conversation-detail";
import type { SessionsSelection } from "./selection";
import { TaskRow, WorktreeMark, worktreeName } from "./task-view";

const FILES_SHOWN = 50;

/** How each change's letter is tinted: added green, deleted red, modified amber. */
const CODE_TINT: Record<string, string> = {
  A: "text-emerald-500",
  "?": "text-emerald-500",
  D: "text-(--state-error-fg)",
  U: "text-(--state-error-fg)",
  M: "text-(--state-warning-fg)",
  R: "text-(--state-info-fg)",
  C: "text-(--state-info-fg)",
};

interface SessionDetailProps {
  family: SessionFamily;
  selection: SessionsSelection;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  waits: readonly TerminalWait[];
  visible: boolean;
  onSelect: (selection: SessionsSelection) => void;
  /** Back to the list, where the panel takes its place. */
  onBack: () => void;
}

export function SessionDetail({
  family,
  selection,
  changes,
  activity,
  waits,
  visible,
  onSelect,
  onBack,
}: SessionDetailProps) {
  const session =
    selection.kind === "worktree"
      ? undefined
      : allSessions(family).find((s) => s.key === selection.key);
  const workspaceId =
    session?.workspaceId ?? (selection.kind === "worktree" ? selection.workspaceId : "");
  const worktree = family.worktrees.find((w) => w.workspace.id === workspaceId);
  if (!worktree) return null;
  const worktreeChanges = changes.get(worktree.workspace.id);
  const branch = worktree.branch ?? worktreeChanges?.branch;
  const agent =
    session && selection.kind === "agent"
      ? findAgent(activity, session.key, selection.agentId)
      : undefined;
  if (session && !agent) {
    return (
      <ConversationDetail
        session={session}
        branch={branch}
        activity={activity.get(session.key)}
        visible={visible}
        onSelect={onSelect}
        onBack={onBack}
      />
    );
  }
  if (session && agent) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 px-2 pt-2 @2xl/agents:hidden">
          <BackButton onBack={onBack} />
        </div>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          <AgentDetail
            key={`${session.key}:${agent.id}`}
            worktree={worktree}
            session={session}
            agent={agent}
            asks={(activity.get(session.key)?.asks ?? []).filter((ask) => ask.agentId === agent.id)}
            visible={visible}
            onSelect={onSelect}
          />
        </div>
      </div>
    );
  }
  return (
    <TaskDetail
      family={family}
      worktree={worktree}
      branch={branch}
      base={worktree.isRoot ? undefined : changes.get(family.root.id)?.branch}
      changes={worktreeChanges}
      activity={activity}
      waits={waits}
      visible={visible}
      onSelect={onSelect}
      onBack={onBack}
    />
  );
}

function BackButton({ onBack, className }: { onBack: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className={cn("@2xl/agents:hidden", className)}
      title={t("sessions.detail.back")}
      aria-label={t("sessions.detail.back")}
      onClick={onBack}
    >
      <ArrowLeft aria-hidden className="size-3.5" />
    </Button>
  );
}

/**
 * A worktree: its name and folder, a task's commits ahead of and behind its
 * workspace's branch, its changes, its conversations, and what can be done
 * in it.
 */
function TaskDetail({
  family,
  worktree,
  branch,
  base,
  changes,
  activity,
  waits,
  visible,
  onSelect,
  onBack,
}: {
  family: SessionFamily;
  worktree: WorktreeEntry;
  branch: string | undefined;
  /** The workspace's branch, which a task is compared with. */
  base: string | undefined;
  changes: WorktreeChanges | undefined;
  activity: ActivityByKey;
  waits: readonly TerminalWait[];
  visible: boolean;
  onSelect: (selection: SessionsSelection) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { workspace } = worktree;
  const stats = useChangeStats(workspace.id, base, visible);
  const path = workspace.task?.worktreePath ?? workspace.rootPath;
  const sessions = allSessions(family);
  const rows = sessionsByGroup(worktree.sessions, "");
  return (
    <div className="app-scrollbar h-full min-h-0 overflow-y-auto">
      <div className="flex min-w-0 flex-col gap-4 p-4">
        <header className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <BackButton onBack={onBack} className="-ml-1" />
            <WorktreeMark worktree={worktree} className="size-4 text-foreground" />
            <h2 className="min-w-0 truncate text-app-body-emphasis text-foreground">
              {worktreeName(worktree, branch)}
            </h2>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                size="icon-sm"
                title={t("sessions.detail.show_changes")}
                aria-label={t("sessions.detail.show_changes")}
                onClick={() => showChanges(workspace.id)}
              >
                <FileDiff aria-hidden className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                title={t("sessions.task.open_terminal")}
                aria-label={t("sessions.task.open_terminal")}
                onClick={() => openWorktreeTerminal(workspace)}
              >
                <SquareTerminal aria-hidden className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                title={t("sessions.list.new_claude")}
                aria-label={t("sessions.list.new_claude")}
                onClick={() => openWorktreeChat(workspace)}
              >
                <MessageSquarePlus aria-hidden className="size-3.5" />
              </Button>
              {!worktree.isRoot && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2 gap-1 text-(--state-error-fg)"
                  onClick={() => removeTask(workspace.id)}
                >
                  <Trash2 aria-hidden className="size-3.5" />
                  {t("sessions.detail.remove_task")}
                </Button>
              )}
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2 text-app-micro text-muted-foreground">
            {base && stats?.ahead !== undefined && stats.behind !== undefined && (
              <AheadBehind ahead={stats.ahead} behind={stats.behind} base={base} />
            )}
            <span className="truncate font-mono" title={path}>
              {worktree.isRoot && branch ? `${branch} · ${path}` : path}
            </span>
          </div>
        </header>
        <ChangedFiles changes={changes} stats={stats} />
        {rows.length > 0 ? (
          <ul className="overflow-hidden rounded-(--radius-raised) border border-border">
            {rows.map((session) => (
              <li key={session.key} className="border-t border-border first:border-t-0">
                <TaskRow
                  session={session}
                  activity={activity}
                  waitingOn={waitedOn(session, waits, sessions)}
                  selected={false}
                  onSelect={() => onSelect({ kind: "session", key: session.key })}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-app-ui-sm text-muted-foreground">
            {t("sessions.task.no_conversations")}
          </p>
        )}
      </div>
    </div>
  );
}

/** A task's commits ahead of and behind its workspace's branch, as ↑2 ↓1 vs main. */
function AheadBehind({ ahead, behind, base }: { ahead: number; behind: number; base: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 tabular-nums"
      title={t("sessions.detail.ahead_behind", { ahead, behind, branch: base })}
      data-testid="task-ahead-behind"
    >
      <span className="flex items-center">
        <ArrowUp aria-hidden className="size-3" />
        {ahead}
      </span>
      <span className="flex items-center">
        <ArrowDown aria-hidden className="size-3" />
        {behind}
      </span>
      <span className="max-w-40 truncate font-mono">
        {t("sessions.detail.vs_base", { branch: base })}
      </span>
    </span>
  );
}

function ChangedFiles({
  changes,
  stats,
}: {
  changes: WorktreeChanges | undefined;
  /** Lines added and deleted, once read. */
  stats: GitChangeStats | undefined;
}) {
  const { t } = useTranslation();
  if (!changes) return null;
  if (changes.files.length === 0) {
    return (
      <p className="text-app-ui-sm text-muted-foreground">{t("sessions.detail.no_changes")}</p>
    );
  }
  const shown = changes.files.slice(0, FILES_SHOWN);
  const lines = new Map(stats?.files.map((file) => [file.path, file]));
  const total = stats && totalLines(stats.files);
  return (
    <section
      className="flex flex-col gap-1.5"
      aria-label={t("sessions.detail.changes", { count: changes.files.length })}
    >
      <span className="flex items-center gap-1 text-app-ui-sm text-muted-foreground tabular-nums">
        <FileDiff aria-hidden className="size-3.5" />
        {t("sessions.detail.changes", { count: changes.files.length })}
        {total && <LineCounts lines={total} className="ml-auto" />}
      </span>
      <ul className="flex flex-col rounded-(--radius-raised) border border-border py-1">
        {shown.map((file) => (
          <li key={file.relPath} className="flex min-w-0 items-center gap-3 px-3 py-1">
            <span
              className={cn(
                "w-3 shrink-0 font-mono text-app-micro",
                CODE_TINT[file.code] ?? "text-muted-foreground",
              )}
            >
              {file.code}
            </span>
            <span
              className="truncate font-mono text-app-micro text-foreground"
              title={file.relPath}
            >
              {file.relPath}
            </span>
            <LineCounts lines={lines.get(file.relPath)} className="ml-auto" />
          </li>
        ))}
        {changes.files.length > shown.length && (
          <li className="px-3 py-1 text-app-micro text-muted-foreground">
            {t("sessions.detail.more_changes", { count: changes.files.length - shown.length })}
          </li>
        )}
      </ul>
    </section>
  );
}

/** The lines all the files add and delete. */
function totalLines(files: readonly FileLineStats[]): FileLineStats {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += file.added;
    deleted += file.deleted;
  }
  return { path: "", added, deleted };
}

/** +12 −3, the parts that are not zero; "binary" for a binary file. */
function LineCounts({
  lines,
  className,
}: {
  lines: FileLineStats | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!lines) return null;
  if (lines.binary) {
    return (
      <span className={cn("shrink-0 text-app-micro text-muted-foreground", className)}>
        {t("sessions.detail.binary")}
      </span>
    );
  }
  if (lines.added === 0 && lines.deleted === 0) return null;
  return (
    <span
      className={cn("flex shrink-0 gap-1.5 font-mono text-app-micro tabular-nums", className)}
      title={t("sessions.detail.lines", { added: lines.added, deleted: lines.deleted })}
    >
      {lines.added > 0 && <span className="text-emerald-500">+{lines.added}</span>}
      {lines.deleted > 0 && (
        <span className="text-(--state-error-fg)">{`\u2212${lines.deleted}`}</span>
      )}
    </span>
  );
}
