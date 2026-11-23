import {
  Check,
  CheckCheck,
  Clock,
  FileDiff,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  compareStatusTime,
  ROW_GROUPS,
  type RowFacts,
  type RowGroup,
} from "../../services/agent-sessions/rows";
import {
  type SessionTreeNode,
  searchSessionTree,
  sessionTree,
  treeSessions,
} from "../../services/agent-sessions/session-tree";
import type { WorktreeChanges } from "../../services/agent-sessions/use-family";
import { markRead } from "../../services/agent-sessions/use-inbox";
import { useFirstPermission, useRowFacts } from "../../services/agent-sessions/use-row-facts";
import { orderSessions } from "../../services/agent-view/order";
import { statusTrees } from "../../services/agent-view/sidebar-tree";
import { existingChatController } from "../../services/chat/claude/controller";
import { existingCodexController } from "../../services/chat/codex/controller";
import { resumeTimeText } from "../../services/chat/limit-resume";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useUIStore } from "../../state/stores/ui";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { showToast } from "../ui/toast";
import { AgentRows } from "./agent-rows";
import { type AgentListSelection, isSessionSelected } from "./selection";
import { SessionProfileMark } from "./session-profile";
import { rowShellClass, SessionRowLines } from "./session-row";
import {
  GROUP_STATE,
  GROUP_TINT,
  SessionSign,
  StateGlyph,
  stateLabel,
  useDurationLabel,
} from "./session-status";
import { FamilyFold, FoldChevron, ParentCaption, SessionTreeBranch } from "./session-tree-rows";

export { GROUP_STATE, GROUP_TINT } from "./session-status";

interface StatusViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  activity: ActivityByKey;
  selection: AgentListSelection | null;
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
  const folds = useUIStore((s) => s.agentListFoldedGroups);
  const familyFolds = useAgentViewStore((s) => s.folded);
  const order = useAgentViewStore((s) => s.order);
  const tree = useMemo(() => sessionTree(allSessions(family)), [family]);
  const byStatus = useMemo(() => statusTrees(searchSessionTree(tree, query)), [tree, query]);
  const worktreeOf = (session: AgentSession) =>
    family.worktrees.find((w) => w.workspace.id === session.workspaceId);
  const searching = query.trim() !== "";

  const groups = ROW_GROUPS.map((group) => ({
    group,
    rows: orderSessions(
      byStatus[group]
        .map((node) => ({ key: node.session.key, node }))
        .sort((a, b) => compareStatusTime(group, a.node.since, b.node.since)),
      order[`status:${group}`],
    ).map(({ node }) => node),
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
        if (rows.length === 0) {
          if (searching) return null;
          return (
            <section key={group} aria-label={label}>
              <StatusGroupHeading group={group} count={0} folded={false} />
            </section>
          );
        }
        const folded = !searching && folds.has(group);
        return (
          <section key={group} aria-label={label} className="flex flex-col gap-1">
            <StatusGroupHeading
              group={group}
              count={rows.length}
              folded={folded}
              onMarkRead={
                group === "done"
                  ? () =>
                      markRead(
                        [...treeSessions(rows)].flatMap((session) => {
                          const workspace = worktreeOf(session)?.workspace;
                          return workspace ? [{ workspace, session }] : [];
                        }),
                      )
                  : undefined
              }
            />
            {!folded &&
              rows.map((root) => (
                <SessionTreeBranch
                  key={root.session.key}
                  node={root}
                  folded={familyFolds}
                  searching={searching}
                  groupIdle
                  testPrefix="agent-list"
                  renderRow={(node, collapsed) => {
                    const { session } = node;
                    const worktree = worktreeOf(session);
                    return (
                      <SessionRow
                        node={node}
                        collapsed={collapsed}
                        workspace={worktree?.workspace}
                        branch={
                          worktree && !worktree.isRoot
                            ? (worktree.branch ??
                              worktree.workspace.task?.branch ??
                              changes.get(session.workspaceId)?.branch)
                            : undefined
                        }
                        changed={changes.get(session.workspaceId)?.files.length ?? 0}
                        activity={activity.get(session.key)}
                        selected={isSessionSelected(selection, session.key)}
                        selectedAgentId={
                          selection?.kind === "agent" && selection.key === session.key
                            ? selection.agentId
                            : undefined
                        }
                        onSelect={onSelect}
                      />
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

export function StatusGroupHeading({
  group,
  count,
  folded,
  onMarkRead,
}: {
  group: RowGroup;
  count: number;
  folded: boolean;
  onMarkRead?: () => void;
}) {
  const { t } = useTranslation();
  const label = t(`agentList.group.${group}`);
  if (count === 0) {
    return (
      <h3 className="flex items-center gap-1.5 px-2 py-1 text-app-ui-sm text-muted-foreground opacity-60">
        <span aria-hidden className="size-3.5 shrink-0" />
        <StateGlyph state={GROUP_STATE[group]} still />
        <span>{label}</span>
        <span className="tabular-nums">0</span>
      </h3>
    );
  }
  return (
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
        <FoldChevron folded={folded} />
        <StateGlyph state={GROUP_STATE[group]} />
        <span>{label}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      {onMarkRead && (
        <IconButton
          label={t("inbox.mark_read")}
          onClick={onMarkRead}
          data-testid="agent-list-mark-read"
        >
          <CheckCheck aria-hidden className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

const SessionRow = memo(function SessionRow({
  node,
  collapsed,
  workspace,
  branch,
  changed,
  activity,
  selected,
  selectedAgentId,
  onSelect: select,
}: {
  node: SessionTreeNode;
  collapsed: boolean;
  workspace: WorkspaceMeta | undefined;
  branch: string | undefined;
  changed: number;
  activity: SessionActivity | undefined;
  selected: boolean;
  selectedAgentId: string | undefined;
  onSelect: StatusViewProps["onSelect"];
}) {
  const { t } = useTranslation();
  const { session, count } = node;
  const group = session.phase;
  const facts = useRowFacts(session, activity);
  const onSelect = (from: HTMLElement) => select({ kind: "session", key: session.key }, from);
  const onSelectAgent = (agentId: string, from: HTMLElement) =>
    select({ kind: "agent", key: session.key, agentId }, from);
  const duration = useDurationLabel(session.since);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && selectedAgentId === undefined)
      rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected, selectedAgentId]);
  const told = [
    session.title,
    duration,
    facts.context !== undefined && `${t("agentList.list.context")} ${facts.context}%`,
    facts.todos && `${t("agentList.detail.todos")} ${facts.todos.done}/${facts.todos.total}`,
    facts.subagents > 0 && `${t("agentList.list.subagents")} ${facts.subagents}`,
  ].filter(Boolean);
  return (
    <div
      ref={rowRef}
      className={cn(
        "group/row",
        rowShellClass({
          attention: group === "attention",
          selected: selected && "bg-[var(--sidebar-item-selected-bg)]",
        }),
        selected && "border-[var(--state-selected-indicator)]",
      )}
      data-testid="agent-list-row"
      data-session-key={session.key}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={session.title}
        onClick={(event) => onSelect(event.currentTarget)}
        className="absolute inset-0 rounded-(--radius-raised) outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <SessionRowLines
        icon={<AgentMark session={session} />}
        title={session.title}
        titleHint={told.join(" · ")}
        sign={
          <>
            <SessionProfileMark session={session} nameClassName="@max-xs/agents:hidden" />
            <SessionSign session={session} facts={facts} />
          </>
        }
        time={duration}
        timeHint={stateLabel(session)}
        urgent={group === "attention" && session.state !== "error"}
        actions={
          group === "done" && (
            <ResultActions session={session} workspace={workspace} changed={changed} />
          )
        }
        place={branch ? { kind: "branch", name: branch } : undefined}
        placeTestId="agent-list-branch"
        parent={<ParentCaption node={node} />}
        preview={<RowLine session={session} facts={facts} />}
        family={
          count > 0 && (
            <FamilyFold
              session={session}
              count={count}
              collapsed={collapsed}
              counts={node.counts}
              testPrefix="agent-list"
            />
          )
        }
      />
      {group === "attention" && (
        <div className="relative flex justify-end pt-1 empty:hidden">
          <RowAnswer session={session} activity={activity} />
        </div>
      )}
      <AgentRows
        agents={activity?.agents ?? []}
        selectedId={selectedAgentId}
        onSelect={onSelectAgent}
        className="relative mt-1"
      />
    </div>
  );
});

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

export function ToolIcon({ name }: { name: string }) {
  const cls = "size-3.5 shrink-0";
  if (EDIT_TOOLS.has(name)) return <Pencil aria-hidden className={cn(cls, "text-emerald-500")} />;
  if (COMMAND_TOOLS.has(name)) {
    return <SquareTerminal aria-hidden className={cn(cls, "text-emerald-500")} />;
  }
  if (SEARCH_TOOLS.has(name)) return <Search aria-hidden className={cn(cls, "text-emerald-500")} />;
  return <Wrench aria-hidden className={cn(cls, "text-emerald-500")} />;
}

export function RowLine({ session, facts }: { session: AgentSession; facts: RowFacts }) {
  const { t, i18n } = useTranslation();
  const wait = facts.wait;
  if (wait?.kind === "permission" || (!wait && session.state === "permissionPending")) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="max-w-[60%] shrink-0 truncate font-medium text-foreground">
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
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-foreground">{text || stateLabel(session)}</span>
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
        <span className="min-w-0 truncate text-foreground">
          {wait.text || t("chat.plan.title")}
        </span>
      </span>
    );
  }
  if (session.limitWait && session.phase !== "running") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <Clock aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate" data-testid="agent-row-limit-wait">
          {t("chat.limit_resume.status", {
            time: resumeTimeText(session.limitWait.at, Date.now(), i18n.language),
          })}
        </span>
      </span>
    );
  }
  if (session.state === "error") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-(--state-error-fg)">
        <span className="min-w-0 truncate">{session.message || stateLabel(session)}</span>
      </span>
    );
  }
  if (session.phase === "running") {
    if (facts.tool) {
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <ToolIcon name={facts.tool.name} />
          <span className="max-w-[60%] shrink-0 truncate text-foreground">{facts.tool.name}</span>
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
    <span className="min-w-0 truncate text-foreground">{plainPreview(session.message)}</span>
  ) : null;
}

function ResultActions({
  session,
  workspace,
  changed,
}: {
  session: AgentSession;
  workspace: WorkspaceMeta | undefined;
  changed: number;
}) {
  const { t } = useTranslation();
  return (
    <>
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
    </>
  );
}

const NO_ASKS: readonly PermissionAsk[] = [];

function RowAnswer({
  session,
  activity,
}: {
  session: AgentSession;
  activity: SessionActivity | undefined;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const firstRequest = useFirstPermission(session);
  const asks = useUnansweredAsks(session, activity?.asks ?? NO_ASKS);
  let answer: ((allow: boolean) => Promise<void>) | null = null;
  if (session.kind !== "terminal") {
    const request = firstRequest;
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
