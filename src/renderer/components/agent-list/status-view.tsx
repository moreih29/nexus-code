// Agent list — the status view: the conversations by where they stand for
// the user, those waiting on them first. A row says what its conversation
// waits on or does now, and a permission is answered in the row itself;
// those idle or ended fold away at the bottom.

import {
  Bot,
  Check,
  CheckCheck,
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
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { PermissionAsk, SessionActivity } from "../../../shared/claude/activity";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { showChanges } from "../../services/agent-sessions/actions";
import type { ActivityByKey } from "../../services/agent-sessions/agents";
import { markAnswered, useUnansweredAsks } from "../../services/agent-sessions/answered-asks";
import {
  type AgentSession,
  allSessions,
  type SessionFamily,
} from "../../services/agent-sessions/model";
import { plainPreview } from "../../services/agent-sessions/preview";
import {
  chatRowFacts,
  hookRowFacts,
  ROW_GROUPS,
  type RowFacts,
  type RowGroup,
  sessionsIn,
} from "../../services/agent-sessions/rows";
import type { WorktreeChanges } from "../../services/agent-sessions/use-family";
import { markRead } from "../../services/agent-sessions/use-inbox";
import { existingCodexController } from "../../services/chat/codex-controller";
import { existingChatController } from "../../services/chat/controller";
import { type ChatTabState, chatKey, useChatStore } from "../../services/chat/store";
import { useUIStore } from "../../state/stores/ui";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { Button } from "../ui/button";
import { ContextRing } from "../ui/context-ring";
import { IconButton } from "../ui/icon-button";
import { showToast } from "../ui/toast";
import { AgentRows } from "./agent-rows";
import { type AgentListSelection, isSessionSelected } from "./selection";
import { SessionProfileMark } from "./session-profile";
import { StateGlyph, stateLabel, useDurationLabel } from "./session-status";

/** The state whose glyph stands for a group. */
export const GROUP_STATE: Record<RowGroup, string> = {
  attention: "permissionPending",
  running: "running",
  done: "completed",
  idle: "idle",
  ended: "exited",
};

export const GROUP_TINT: Record<RowGroup, string> = {
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
  selection: AgentListSelection | null;
  /** A conversation picked, or an agent, with the row it was picked from. */
  onSelect: (selection: AgentListSelection, from: HTMLElement) => void;
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
  // Every group is open until the user folds it; the folds are kept across restarts.
  const folds = useUIStore((s) => s.agentListFoldedGroups);
  const sessions = allSessions(family);
  const worktreeOf = (session: AgentSession) =>
    family.worktrees.find((w) => w.workspace.id === session.workspaceId);
  const searching = query.trim() !== "";

  const groups = ROW_GROUPS.map((group) => ({
    group,
    rows: sessionsIn(sessions, group, query),
  }));
  if (groups.every(({ rows }) => rows.length === 0)) {
    return (
      <p className="p-4 text-app-ui-sm text-muted-foreground">
        {searching ? t("agentList.list.no_match") : t("agentList.none")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-2" data-testid="agent-list-status-view">
      {groups.map(({ group, rows }) => {
        const label = t(`agentList.group.${group}`);
        // A group with none shows as its one dim line, so the groups keep their places.
        if (rows.length === 0) {
          // A search tells only what it found.
          if (searching) return null;
          return (
            <section key={group} aria-label={label}>
              <h3 className="flex items-center gap-1.5 px-2 py-1 text-app-ui-sm text-muted-foreground opacity-60">
                <StateGlyph state={GROUP_STATE[group]} still />
                <span>{label}</span>
                <span className="tabular-nums">0</span>
              </h3>
            </section>
          );
        }
        // A search shows what it found, folded groups too.
        const folded = !searching && folds.has(group);
        return (
          <section key={group} aria-label={label} className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-expanded={!folded}
                onClick={() => useUIStore.getState().toggleAgentListGroup(group)}
                className={cn(
                  "flex items-center gap-1.5 rounded-(--radius-control) px-2 py-1 text-app-ui-sm font-medium hover:bg-[var(--state-hover-bg)]",
                  GROUP_TINT[group],
                )}
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
              {group === "done" && rows.length > 1 && (
                <IconButton
                  label={t("inbox.mark_read")}
                  onClick={() =>
                    markRead(
                      rows.flatMap((session) => {
                        const workspace = worktreeOf(session)?.workspace;
                        return workspace ? [{ workspace, session }] : [];
                      }),
                    )
                  }
                  data-testid="agent-list-mark-read"
                >
                  <CheckCheck aria-hidden className="size-3.5" />
                </IconButton>
              )}
            </div>
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
                    selected={isSessionSelected(selection, session.key)}
                    selectedAgentId={
                      selection?.kind === "agent" && selection.key === session.key
                        ? selection.agentId
                        : undefined
                    }
                    onSelect={(from) => onSelect({ kind: "session", key: session.key }, from)}
                    onSelectAgent={(agentId, from) =>
                      onSelect({ kind: "agent", key: session.key, agentId }, from)
                    }
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
  selectedAgentId,
  onSelect,
  onSelectAgent,
}: {
  session: AgentSession;
  group: RowGroup;
  workspace: WorkspaceMeta | undefined;
  branch: string | undefined;
  changed: number;
  chat: ChatTabState | undefined;
  activity: SessionActivity | undefined;
  selected: boolean;
  /** Its agent selected, when one is. */
  selectedAgentId: string | undefined;
  onSelect: (from: HTMLElement) => void;
  onSelectAgent: (agentId: string, from: HTMLElement) => void;
}) {
  const facts =
    session.kind === "terminal"
      ? hookRowFacts(activity)
      : chat
        ? chatRowFacts(chat.model, activity)
        : hookRowFacts(undefined);
  const duration = useDurationLabel(session.since);
  const compact = group === "idle" || group === "ended";
  // The row of the tab the user went to stays in sight, as the file tree's does.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && selectedAgentId === undefined)
      rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected, selectedAgentId]);
  return (
    <div
      ref={rowRef}
      className={cn(
        "relative rounded-(--radius-raised) border px-3 text-app-ui-sm transition-colors",
        compact ? "py-1.5" : "py-2",
        selected
          ? "border-[var(--state-selected-indicator)] bg-[var(--sidebar-item-selected-bg)]"
          : group === "attention"
            ? "border-(--state-warning-fg)/40 bg-(--state-warning-fg)/5 hover:bg-[var(--state-hover-bg)]"
            : "border-transparent hover:bg-[var(--state-hover-bg)]",
      )}
      data-testid="agent-list-row"
    >
      {/* The row as one button behind its content, so the row's own buttons stay buttons. */}
      <button
        type="button"
        aria-pressed={selected}
        aria-label={session.title}
        onClick={(event) => onSelect(event.currentTarget)}
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
            title={duration ? `${session.title} · ${duration}` : session.title}
          >
            {session.title}
          </span>
          {/* Narrow, the profile is its dot, and the time is in the row's title. */}
          <SessionProfileMark session={session} nameClassName="@max-xs/agents:hidden" />
          {duration && (
            <span
              className={cn(
                "shrink-0 text-app-micro tabular-nums @max-[200px]/agents:hidden",
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
      {/* Above the row's own button, as the row's other buttons are. */}
      <AgentRows
        agents={activity?.agents ?? []}
        selectedId={selectedAgentId}
        onSelect={onSelectAgent}
        className="relative mt-1"
      />
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

/** A call's kind as an icon: an edit, a command, a search, or any other tool. */
export function ToolIcon({ name }: { name: string }) {
  const cls = "size-3.5 shrink-0";
  if (EDIT_TOOLS.has(name)) return <Pencil aria-hidden className={cn(cls, "text-emerald-500")} />;
  if (COMMAND_TOOLS.has(name)) {
    return <SquareTerminal aria-hidden className={cn(cls, "text-emerald-500")} />;
  }
  if (SEARCH_TOOLS.has(name)) return <Search aria-hidden className={cn(cls, "text-emerald-500")} />;
  return <Wrench aria-hidden className={cn(cls, "text-emerald-500")} />;
}

/** The line under the title: what the conversation waits on, does, or answered. */
export function RowLine({ session, facts }: { session: AgentSession; facts: RowFacts }) {
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
            {t("agentList.list.questions", { count: wait.count })}
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
  // The answer, in Markdown, as plain words.
  return session.message ? (
    <span className="line-clamp-2 min-w-0 break-words text-foreground">
      {plainPreview(session.message)}
    </span>
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
        title={t("agentList.detail.todos")}
      >
        <ListChecks aria-hidden className="size-3 shrink-0" />
        {facts.todos.done}/{facts.todos.total}
      </span>
    ),
    facts.subagents > 0 && (
      <span
        key="subagents"
        className="flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums"
        title={t("agentList.list.subagents")}
      >
        <Bot aria-hidden className="size-3 shrink-0" />
        {facts.subagents}
      </span>
    ),
    facts.context !== undefined && (
      <span
        key="context"
        className="flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground tabular-nums"
        title={t("agentList.list.context")}
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
              title={t("agentList.detail.show_changes")}
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
              title={t("agentList.list.mark_read")}
              aria-label={t("agentList.list.mark_read")}
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

const NO_ASKS: readonly PermissionAsk[] = [];

/**
 * Allow or deny a permission from the row: a chat tab's through its
 * program, a terminal's through Claude Code's hook. A question or a plan is
 * answered in its tab, where there is room for it.
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
  // A terminal's request answered here leaves at once, not with the next poll.
  const asks = useUnansweredAsks(session, activity?.asks ?? NO_ASKS);
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
    const ask = asks[0];
    if (ask) {
      answer = async (allow) => {
        const result = await ipcCallResult("claude", "answerPermission", {
          workspaceId: session.workspaceId,
          tabId: session.tabId,
          askId: ask.id,
          answer: allow ? "allow" : "deny",
          ...(allow ? {} : { message: "" }),
        });
        if (!result.ok || !result.value) throw new Error(t("agentList.list.answer_failed"));
        markAnswered(session, ask.id);
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
