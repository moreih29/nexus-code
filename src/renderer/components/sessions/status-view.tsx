// Agents tab — the status view: the conversations by where they stand for
// the user, those waiting on them first. A row says what its conversation
// waits on or does now, and a permission is answered in the row itself;
// those idle or ended fold away at the bottom.

import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  GitBranch,
  ListChecks,
  ListTodo,
  MessageCircleQuestion,
  Pencil,
  Search,
  Shield,
  SquareTerminal,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { SessionActivity } from "../../../shared/claude/activity";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { existingCodexController } from "../../services/chat/codex-controller";
import { existingChatController } from "../../services/chat/controller";
import { type ChatTabState, chatKey, useChatStore } from "../../services/chat/store";
import { showChanges } from "../../services/sessions/actions";
import type { ActivityByKey } from "../../services/sessions/agents";
import { type AgentSession, allSessions, type SessionFamily } from "../../services/sessions/model";
import {
  chatRowFacts,
  hookRowFacts,
  ROW_GROUPS,
  type RowFacts,
  type RowGroup,
  sessionsIn,
} from "../../services/sessions/rows";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import { markRead } from "../../services/sessions/use-inbox";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { Button } from "../ui/button";
import { showToast } from "../ui/toast";
import { isSessionSelected, type SessionsSelection } from "./selection";
import { StateGlyph, stateLabel, useDurationLabel } from "./session-status";

/** The groups that start folded. */
const FOLDED: ReadonlySet<RowGroup> = new Set(["idle", "ended"]);

/** The state whose glyph stands for a group. */
const GROUP_STATE: Record<RowGroup, string> = {
  attention: "permissionPending",
  running: "running",
  done: "completed",
  idle: "idle",
  ended: "exited",
};

const GROUP_TINT: Record<RowGroup, string> = {
  attention: "text-(--state-warning-fg)",
  running: "text-emerald-500",
  done: "text-(--tab-claude-attention-fg)",
  idle: "text-muted-foreground",
  ended: "text-muted-foreground",
};

interface StatusViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
  query: string;
}

export function StatusView({
  family,
  changes,
  activity,
  selection,
  onSelect,
  query,
}: StatusViewProps) {
  const { t } = useTranslation();
  const chats = useChatStore((s) => s.tabs);
  const [open, setOpen] = useState<ReadonlySet<RowGroup>>(() => new Set());
  const sessions = allSessions(family);
  const worktreeOf = (session: AgentSession) =>
    family.worktrees.find((w) => w.workspace.id === session.workspaceId);
  const searching = query.trim() !== "";

  const groups = ROW_GROUPS.map((group) => ({
    group,
    rows: sessionsIn(sessions, group, query),
  })).filter(({ rows }) => rows.length > 0);
  if (groups.length === 0) {
    return (
      <p className="p-4 text-app-ui-sm text-muted-foreground">
        {searching ? t("sessions.list.no_match") : t("sessions.none")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="sessions-status-view">
      {groups.map(({ group, rows }) => {
        // A search shows what it found, folded groups too.
        const folded = FOLDED.has(group) && !open.has(group) && !searching;
        const label = t(`sessions.group.${group}`);
        return (
          <section key={group} aria-label={label} className="flex flex-col gap-1">
            {FOLDED.has(group) ? (
              <button
                type="button"
                aria-expanded={!folded}
                onClick={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(group)) next.delete(group);
                    else next.add(group);
                    return next;
                  })
                }
                className="flex items-center gap-1.5 self-start rounded-(--radius-control) px-2 py-1 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
              >
                <StateGlyph state={GROUP_STATE[group]} />
                <span>{label}</span>
                <span className="tabular-nums">{rows.length}</span>
                {folded ? (
                  <ChevronRight aria-hidden className="size-3.5" />
                ) : (
                  <ChevronDown aria-hidden className="size-3.5" />
                )}
              </button>
            ) : (
              <h3
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 text-app-ui-sm font-medium",
                  GROUP_TINT[group],
                )}
              >
                <StateGlyph state={GROUP_STATE[group]} />
                <span>{label}</span>
                <span className="tabular-nums">{rows.length}</span>
              </h3>
            )}
            {!folded &&
              rows.map((session) => {
                const worktree = worktreeOf(session);
                return (
                  <SessionRow
                    key={session.key}
                    session={session}
                    group={group}
                    workspace={worktree?.workspace}
                    branch={worktree?.branch ?? changes.get(session.workspaceId)?.branch}
                    changed={changes.get(session.workspaceId)?.files.length ?? 0}
                    chat={chats[chatKey(session.workspaceId, session.tabId)]}
                    activity={activity.get(session.key)}
                    selected={
                      isSessionSelected(selection, session.key) ||
                      (selection?.kind === "agent" && selection.key === session.key)
                    }
                    onSelect={() => onSelect({ kind: "session", key: session.key })}
                  />
                );
              })}
          </section>
        );
      })}
    </div>
  );
}

function SessionRow({
  session,
  group,
  workspace,
  branch,
  changed,
  chat,
  activity,
  selected,
  onSelect,
}: {
  session: AgentSession;
  group: RowGroup;
  workspace: WorkspaceMeta | undefined;
  branch: string | undefined;
  changed: number;
  chat: ChatTabState | undefined;
  activity: SessionActivity | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const facts =
    session.kind === "terminal"
      ? hookRowFacts(activity)
      : chat
        ? chatRowFacts(chat.model)
        : hookRowFacts(undefined);
  const duration = useDurationLabel(session.since);
  const compact = group === "idle" || group === "ended";
  return (
    <div
      className={cn(
        "relative rounded-(--radius-raised) border px-3 text-app-ui-sm transition-colors",
        compact ? "py-1.5" : "py-2",
        selected
          ? "border-[var(--state-selected-indicator)] bg-[var(--sidebar-item-selected-bg)]"
          : group === "attention"
            ? "border-(--state-warning-fg)/40 bg-(--state-warning-fg)/5 hover:bg-[var(--state-hover-bg)]"
            : "border-transparent hover:bg-[var(--state-hover-bg)]",
      )}
      data-testid="sessions-row"
    >
      {/* The row as one button behind its content, so the row's own buttons stay buttons. */}
      <button
        type="button"
        aria-pressed={selected}
        aria-label={session.title}
        onClick={onSelect}
        className="absolute inset-0 rounded-(--radius-raised) outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <AgentMark session={session} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              compact ? "text-foreground" : "font-medium text-foreground",
            )}
            title={session.title}
          >
            {session.title}
          </span>
          {duration && (
            <span
              className={cn(
                "shrink-0 text-app-micro tabular-nums",
                group === "attention" ? GROUP_TINT.attention : "text-muted-foreground",
              )}
              title={stateLabel(session)}
            >
              {duration}
            </span>
          )}
        </div>
        {!compact && <RowLine session={session} facts={facts} />}
        {!compact && (
          <RowFooter
            session={session}
            group={group}
            facts={facts}
            workspace={workspace}
            branch={branch}
            changed={changed}
            chat={chat}
            activity={activity}
          />
        )}
      </div>
    </div>
  );
}

/** Claude's or Codex's mark, or a terminal's for an agent known only by its output. */
export function AgentMark({ session, className }: { session: AgentSession; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  if (session.kind === "codex" || session.agent === "codex") {
    return <CodexIcon aria-hidden className={cls} />;
  }
  if (session.kind === "claude" || session.agent === "claude") {
    return <ClaudeIcon aria-hidden className={cls} />;
  }
  return <SquareTerminal aria-hidden className={cn(cls, "text-muted-foreground")} />;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Delete"]);
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "PowerShell", "KillShell"]);
const SEARCH_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch"]);

function ToolIcon({ name }: { name: string }) {
  const cls = "size-3.5 shrink-0";
  if (EDIT_TOOLS.has(name)) return <Pencil aria-hidden className={cn(cls, "text-emerald-500")} />;
  if (COMMAND_TOOLS.has(name)) {
    return <SquareTerminal aria-hidden className={cn(cls, "text-emerald-500")} />;
  }
  if (SEARCH_TOOLS.has(name)) return <Search aria-hidden className={cn(cls, "text-emerald-500")} />;
  return <Wrench aria-hidden className={cn(cls, "text-emerald-500")} />;
}

/** The line under the title: what the conversation waits on, does, or answered. */
function RowLine({ session, facts }: { session: AgentSession; facts: RowFacts }) {
  const { t } = useTranslation();
  const wait = facts.wait;
  const warn = "size-3.5 shrink-0 text-(--state-warning-fg)";
  if (wait?.kind === "permission" || (!wait && session.state === "permissionPending")) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Shield aria-hidden className={warn} />
        <span className="shrink-0 font-medium text-foreground">
          {wait?.kind === "permission" ? wait.tool : stateLabel(session)}
        </span>
        {wait?.kind === "permission" && wait.target && (
          <span className="min-w-0 truncate font-mono text-app-micro text-muted-foreground">
            {wait.target}
          </span>
        )}
      </span>
    );
  }
  if (wait?.kind === "question" || (!wait && session.state === "needsInput")) {
    const text = wait?.kind === "question" ? wait.text : session.message;
    return (
      <span className="flex min-w-0 items-start gap-1.5">
        <MessageCircleQuestion aria-hidden className={cn(warn, "mt-0.5")} />
        <span className="line-clamp-2 min-w-0 break-words text-foreground">
          {text || stateLabel(session)}
        </span>
        {wait?.kind === "question" && wait.count > 1 && (
          <span className="ml-auto shrink-0 text-app-micro text-muted-foreground tabular-nums">
            {t("sessions.list.questions", { count: wait.count })}
          </span>
        )}
      </span>
    );
  }
  if (wait?.kind === "plan") {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <ListTodo aria-hidden className={warn} />
        <span className="min-w-0 truncate text-foreground">
          {wait.text || t("chat.plan.title")}
        </span>
      </span>
    );
  }
  if (session.state === "error") {
    return (
      <span className="flex min-w-0 items-start gap-1.5 text-(--state-error-fg)">
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="line-clamp-2 min-w-0 break-words">
          {session.message || stateLabel(session)}
        </span>
      </span>
    );
  }
  if (session.phase === "running") {
    if (facts.tool) {
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <ToolIcon name={facts.tool.name} />
          <span className="shrink-0 text-foreground">{facts.tool.name}</span>
          {facts.tool.target && (
            <span className="min-w-0 truncate font-mono text-app-micro text-muted-foreground">
              {facts.tool.target}
            </span>
          )}
        </span>
      );
    }
    return session.prompt ? (
      <span className="min-w-0 truncate text-muted-foreground">{session.prompt}</span>
    ) : null;
  }
  return session.message ? (
    <span className="line-clamp-2 min-w-0 break-words text-foreground">{session.message}</span>
  ) : null;
}

/** The chips that tell how far it is, and the row's own buttons. */
function RowFooter({
  session,
  group,
  facts,
  workspace,
  branch,
  changed,
  chat,
  activity,
}: {
  session: AgentSession;
  group: RowGroup;
  facts: RowFacts;
  workspace: WorkspaceMeta | undefined;
  branch: string | undefined;
  changed: number;
  chat: ChatTabState | undefined;
  activity: SessionActivity | undefined;
}) {
  const { t } = useTranslation();
  const chips = [
    branch && (
      <span
        key="branch"
        className="flex min-w-0 items-center gap-1 rounded-(--radius-control) bg-muted px-1.5 font-mono text-app-micro text-muted-foreground"
        title={branch}
      >
        <GitBranch aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{branch}</span>
      </span>
    ),
    facts.todos && (
      <span
        key="todos"
        className="flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums"
        title={t("sessions.detail.todos")}
      >
        <ListChecks aria-hidden className="size-3 shrink-0" />
        {facts.todos.done}/{facts.todos.total}
      </span>
    ),
    facts.subagents > 0 && (
      <span
        key="subagents"
        className="flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums"
        title={t("sessions.list.subagents")}
      >
        <Bot aria-hidden className="size-3 shrink-0" />
        {facts.subagents}
      </span>
    ),
    facts.context !== undefined && (
      <span
        key="context"
        className="flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums"
        title={t("sessions.list.context")}
      >
        <ContextRing percent={facts.context} />
        {facts.context}%
      </span>
    ),
  ].filter(Boolean);
  const answer =
    group === "attention" ? <RowAnswer session={session} chat={chat} activity={activity} /> : null;
  const done = group === "done";
  if (chips.length === 0 && !answer && !done) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">{chips}</div>
      {answer}
      {done && (
        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
          {changed > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-1.5 text-app-micro"
              title={t("sessions.detail.show_changes")}
              onClick={() => showChanges(session.workspaceId)}
            >
              <FileDiff aria-hidden className="size-3.5" />
              <span className="tabular-nums">{changed}</span>
            </Button>
          )}
          {workspace && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-6"
              title={t("sessions.list.mark_read")}
              aria-label={t("sessions.list.mark_read")}
              onClick={() => markRead([{ workspace, session }])}
            >
              <Check aria-hidden className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** How full the context is, as a ring. */
function ContextRing({ percent }: { percent: number }) {
  const r = 5;
  const length = 2 * Math.PI * r;
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" className="size-3 shrink-0 -rotate-90">
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={2}
      />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeDasharray={`${(length * percent) / 100} ${length}`}
        className={percent >= 80 ? "text-(--state-warning-fg)" : "text-(--state-loading-indicator)"}
      />
    </svg>
  );
}

/**
 * Allow or deny a permission from the row: a chat tab's through its
 * program, a terminal's through Claude Code's hook. A question or a plan is
 * answered in the detail panel, where there is room for it.
 */
function RowAnswer({
  session,
  chat,
  activity,
}: {
  session: AgentSession;
  chat: ChatTabState | undefined;
  activity: SessionActivity | undefined;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  let answer: ((allow: boolean) => Promise<void>) | null = null;
  if (session.kind !== "terminal") {
    const request = chat?.model.permissions[0];
    const controller =
      session.kind === "codex"
        ? existingCodexController(session.workspaceId, session.tabId)
        : existingChatController(session.workspaceId, session.tabId);
    if (
      request &&
      controller &&
      request.toolName !== "AskUserQuestion" &&
      request.toolName !== "ExitPlanMode"
    ) {
      answer = (allow) =>
        controller.answerPermission(request, allow ? { kind: "allow" } : { kind: "deny" });
    }
  } else {
    const ask = activity?.asks?.[0];
    if (ask) {
      answer = async (allow) => {
        const result = await ipcCallResult("claude", "answerPermission", {
          workspaceId: session.workspaceId,
          tabId: session.tabId,
          askId: ask.id,
          answer: allow ? "allow" : "deny",
          ...(allow ? {} : { message: "" }),
        });
        if (!result.ok || !result.value) throw new Error(t("sessions.list.answer_failed"));
      };
    }
  }
  if (!answer) return null;
  const send = (allow: boolean) => {
    if (!answer) return;
    setSending(true);
    answer(allow)
      .catch((failure: unknown) =>
        showToast({ kind: "error", message: (failure as Error).message }),
      )
      .finally(() => setSending(false));
  };
  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-1">
      <Button
        size="icon-sm"
        variant="outline"
        className="size-7"
        disabled={sending}
        title={t("chat.permission.deny")}
        aria-label={t("chat.permission.deny")}
        onClick={() => send(false)}
      >
        <X aria-hidden className="size-3.5" />
      </Button>
      <Button size="sm" className="h-7" disabled={sending} onClick={() => send(true)}>
        {t("chat.permission.allow")}
      </Button>
    </div>
  );
}
