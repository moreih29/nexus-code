/**
 * Another computer's chat's side panel, as a chat here has it and with its
 * parts, in the same order: what it runs on and with, its context, the
 * plan's usage, its goal (while it has one), its to-dos, its tasks and agents
 * (what runs now and what ended), what it made, the files it changed and its
 * MCP servers. They come
 * from the panel its computer tells (chat.watch's `panel`), the subagents'
 * details from the conversation shown. A changed file opens its change,
 * read from that computer. Its MCP servers are shown as they stand there,
 * and worked as a chat's here are where that computer lets this one control
 * its chats (a sign-in in the browser here).
 */

import { ExternalLink, FileText, GitFork, MessageSquare, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatPanel } from "../../../../packages/remote-protocol/src/view";
import { useNow } from "../../hooks/use-now";
import type { ChatModel, ToolCall } from "../../services/chat/model";
import {
  type AgentRow,
  type AgentStatus,
  agentsOf,
  changedFilesOf,
  exitCodeOf,
  jobCommand,
} from "../../services/chat/panel";
import { type ActivityRow, activityOf, type JobLike } from "../../services/chat/running";
import { formatTokens } from "../../services/chat/usage-line";
import { usePeerMcp } from "../../services/remote/peer-mcp";
import { peerWorkspaceId } from "../../services/remote/peer-workspace";
import type { RemoteTarget } from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { formatBytes } from "../../utils/format-bytes";
import { useChatLinks } from "../chat/chat-links";
import { Highlighted } from "../chat/code-highlight";
import { GoalSummary, type TabGoal } from "../chat/goal-bar";
import { Row, Section } from "../chat/panel-section";
import { ActivitySections } from "../chat/running-section";
import {
  ChangedRow,
  CopyIcon,
  Field,
  formatCost,
  JobButton,
  JobOutputView,
  Meter,
  ResultsSection,
  TextButton,
  TodosSection,
  useJobOutput,
} from "../chat/side-panel";
import { usageMeterLabel } from "../chat/usage-line";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";
import { showToast } from "../ui/toast";
import { peerProfileName } from "./remote-profile-chip";
import { usageLineOf } from "./remote-usage";

const NO_JOBS: ChatPanel["tasks"] = [];

/** The panel's parts a bare command shows: /status, /context, /usage; /diff its changed files. */
export type RemotePanelPart = "status" | "context" | "usage" | "jobs" | "changes" | "mcp";

/** A part of the panel asked for, each ask its own seq; `id`: the task of the job meant. */
export interface RemotePanelAsk {
  part: RemotePanelPart;
  seq: number;
  id?: string;
}

/** The panel section a bare command reveals. */
export function remotePanelPartOf(text: string): RemotePanelPart | null {
  const match = /^\/(status|context|usage|mcp)$/i.exec(text.trim());
  return (match?.[1]?.toLowerCase() as RemotePanelPart | undefined) ?? null;
}

/** Jobs, agents, checklist and context shown when the pane gets narrow. */
export function panelSummaryCounts(panel: ChatPanel | undefined, agents: readonly AgentRow[]) {
  const todos = panel?.todos ?? [];
  const context = panel?.context;
  return {
    jobs: (panel?.tasks ?? []).filter((job) => job.status === "running").length,
    agents: agents.filter((agent) => agent.status === "running").length,
    todos: todos.length
      ? { done: todos.filter((todo) => todo.status === "completed").length, total: todos.length }
      : null,
    contextPercent: context
      ? Math.min(100, Math.round((context.usedTokens / context.maxTokens) * 100))
      : null,
  };
}

const AGENT_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed", "stopped"]);

/**
 * The chat's subagents: the computer's list, each with what the conversation
 * shown tells of it (its tools, its last words, its task), and those the
 * conversation names that the list does not have yet.
 */
export function remoteAgentsOf(panel: ChatPanel | undefined, model: ChatModel): AgentRow[] {
  const known = new Map(agentsOf(model).map((row) => [row.toolUseId, row]));
  // Its list has every subagent its program runs: one only the conversation
  // names is its history's, and runs no more.
  if (panel) {
    for (const [id, row] of known) {
      if (row.status === "running") known.set(id, { ...row, status: "stopped" });
    }
  }
  const rows: AgentRow[] = [];
  for (const agent of panel?.agents ?? []) {
    const seen = known.get(agent.toolUseId);
    known.delete(agent.toolUseId);
    const status = (AGENT_STATUSES.has(agent.status) ? agent.status : "stopped") as AgentStatus;
    rows.push({
      ...(seen ?? { toolCount: 0, teammate: false }),
      toolUseId: agent.toolUseId,
      description: agent.description || seen?.description || "",
      ...(agent.prompt ? { prompt: agent.prompt } : {}),
      status,
      ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
      ...(agent.endedAt !== undefined ? { endedAt: agent.endedAt } : {}),
    });
  }
  return [...rows, ...known.values()];
}

export function RemoteSidePanel({
  target,
  ...props
}: Omit<SessionPanelProps, "scope" | "mcp" | "onRefreshAccount" | "contextUsed" | "branch"> & {
  target: RemoteTarget;
  onRefreshMcp?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { panel, controls, reveal, onRefreshMcp, ...rest } = props;
  const codex = target.kind === "codex";
  return (
    <SessionSidePanel
      {...rest}
      panel={panel}
      controls={controls}
      reveal={reveal}
      scope={{
        agent: codex ? "codex" : "claude",
        foldKey: `remote:${target.deviceId}:${target.workspaceId}:${target.tabId}`,
        computer: target.deviceName,
        cwd: target.cwd ?? target.path,
        rootPath: target.path,
        workspaceId: peerWorkspaceId(target.deviceId, target.workspaceId),
        profile: target.profile ? peerProfileName(target.profile, t) : undefined,
      }}
      mcp={
        codex ? (
          <CodexPanelMcp
            servers={panel?.mcp}
            onRefresh={onRefreshMcp}
            reveal={reveal?.part === "mcp" ? reveal.seq : undefined}
          />
        ) : panel?.mcp ? (
          <RemoteMcp
            target={target}
            servers={panel.mcp}
            controls={controls && panel.can?.mcp === true}
            reveal={reveal?.part === "mcp" ? reveal.seq : undefined}
          />
        ) : undefined
      }
      testId="remote-side-panel"
    />
  );
}

interface SessionPanelProps {
  scope: {
    agent: "claude" | "codex";
    foldKey: string;
    computer: string;
    cwd: string;
    rootPath: string;
    workspaceId: string;
    profile?: string;
  };
  panel: ChatPanel | undefined;
  model: ChatModel;
  runs?: readonly AgentRow[];
  controls: boolean;
  onShowAgent: (toolUseId: string) => void;
  onShowCall?: (toolUseId: string) => void;
  onCompact?: () => void | Promise<void>;
  onStopTask?: (taskId: string) => void;
  onStopRun?: (runId: string) => void;
  onBackground?: (toolUseId: string) => void;
  onRemoteControl?: (enabled: boolean) => Promise<void>;
  onForkSession?: () => void;
  onRefreshAccount?: () => Promise<void>;
  reveal?: RemotePanelAsk | null;
  goal?: TabGoal | null;
  signedOut?: boolean;
  contextUsed?: number;
  branch?: string | null;
  mcp?: React.ReactNode;
  className?: string;
  testId?: string;
}

/** The common panel sections for a peer's chat and a Codex tab here. */
export function SessionSidePanel({
  scope,
  panel,
  model,
  runs = [],
  controls,
  onShowAgent,
  onShowCall,
  onCompact,
  onStopTask,
  onStopRun,
  onBackground,
  onRemoteControl,
  onForkSession,
  onRefreshAccount,
  reveal,
  goal,
  signedOut,
  contextUsed,
  branch,
  mcp,
  className,
  testId,
}: SessionPanelProps) {
  const { t, i18n } = useTranslation();
  const links = useChatLinks();
  const { agent, foldKey, computer, cwd, rootPath, workspaceId, profile } = scope;
  const codex = agent === "codex";
  const agents = useMemo(() => [...remoteAgentsOf(panel, model), ...runs], [panel, model, runs]);
  const jobs = panel?.tasks ?? NO_JOBS;
  const todos = panel?.todos ?? [];
  const changed = panel?.changedFiles ?? [];
  // A computer before 0.13.0 tells no file it made: the calls read here may.
  const madeHere = useMemo(
    () => new Set(changedFilesOf(model.tools).flatMap((f) => (f.created ? [f.path] : []))),
    [model.tools],
  );
  const { permissions, running: turnRunning } = model;
  const waiting = useMemo(
    () => new Set(permissions.flatMap((p) => (p.toolUseId ? [p.toolUseId] : []))),
    [permissions],
  );
  const activity = useMemo(
    () =>
      activityOf({ agents, jobs, tools: model.tools, items: model.items, waiting, turnRunning }),
    [agents, jobs, model.tools, model.items, waiting, turnRunning],
  );
  const context = panel?.context ?? null;
  const percent =
    context && context.maxTokens > 0
      ? Math.min(100, Math.round((context.usedTokens / context.maxTokens) * 100))
      : null;
  const now = useNow(true, 60_000);
  const usage = usageLineOf(panel, now);
  const limits = usage ? [...usage.meters, ...usage.more] : [];
  const cost = panel?.costUsd;
  const asked = (part: RemotePanelPart) => (reveal?.part === part ? reveal.seq : undefined);
  // Its rows' handlers stay the same as the chat changes, so its list of
  // what ended draws only when that does; each reads what the chat has now.
  const latest = useRef({ model, controls, onShowAgent, onShowCall, onStopTask, onStopRun });
  latest.current = { model, controls, onShowAgent, onShowCall, onStopTask, onStopRun };
  const openRow = useCallback((row: ActivityRow) => {
    const { onShowAgent, onShowCall } = latest.current;
    if (row.agent) onShowAgent(row.agent.toolUseId);
    else if (row.call) onShowCall?.(row.call.id);
  }, []);
  const stopOf = useCallback((row: ActivityRow): (() => void) | undefined => {
    const { model, controls, onStopTask, onStopRun } = latest.current;
    if (!controls || row.status !== "running") return undefined;
    const run = row.agent?.run;
    if (run) return onStopRun && (() => onStopRun(run.id));
    // The task a subagent runs as, which stops it.
    const taskId =
      row.job?.taskId ??
      row.agent?.taskId ??
      Object.values(model.tasks).find((task) => task.toolUseId === row.key)?.taskId;
    return taskId && onStopTask ? () => onStopTask(taskId) : undefined;
  }, []);
  const jobDetail = useCallback(
    (job: JobLike) => (
      <RemoteJobDetail
        job={job as ChatPanel["tasks"][number]}
        tools={latest.current.model.tools}
        workspaceId={workspaceId}
        rootPath={rootPath}
        onShowCall={latest.current.onShowCall}
        onOpenFile={links?.openFile}
      />
    ),
    [workspaceId, rootPath, links],
  );
  const session = panel?.session;
  const version = session?.version ?? model.version;
  let account = session?.account;
  if (signedOut) account = t("chat.codex.commands.status.signed_out");
  else if (codex && (account === "apiKey" || account === "apikey"))
    account = t("chat.panel.env.api_key");
  else if (codex && (account === "chatgpt" || account === "chatgptAuthTokens")) account = "ChatGPT";
  else if (codex && account === "unknown") account = t("chat.panel.env.account_unknown");
  const [compacting, setCompacting] = useState(false);
  const busy = model.running || compacting;
  const [refreshingAccount, setRefreshingAccount] = useState(false);
  const fail = (error: Error) => showToast({ kind: "error", message: error.message });
  const remote = panel?.remoteControl;
  const [switching, setSwitching] = useState(false);
  const canRemote =
    controls &&
    onRemoteControl !== undefined &&
    remote?.available === true &&
    model.process === "running" &&
    !switching;
  const turnRemote = (enabled: boolean) => {
    if (!onRemoteControl) return;
    setSwitching(true);
    onRemoteControl(enabled)
      .catch((error: Error) =>
        showToast({
          kind: "error",
          message: t("chat.panel.env.remote_failed", { error: error.message }),
        }),
      )
      .finally(() => setSwitching(false));
  };

  return (
    <aside
      className={cn("app-scrollbar flex flex-col overflow-y-auto bg-background", className)}
      aria-label={t("chat.panel.aria")}
      data-testid={testId}
    >
      <Section title={t("chat.panel.env.title")} reveal={asked("status")}>
        {remote && (
          <Field label={t("chat.panel.env.remote_control")}>
            <Switch
              checked={remote.enabled}
              disabled={!canRemote}
              onCheckedChange={turnRemote}
              aria-label={t("chat.panel.env.remote_control")}
              title={!remote.available ? t("chat.panel.env.remote_unavailable") : undefined}
            />
            {remote.enabled && remote.url && (
              <>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-app-micro"
                  title={remote.url}
                >
                  {remote.url}
                </span>
                <CopyIcon text={remote.url} label={t("chat.panel.env.copy_url")} />
                <IconButton
                  label={t("chat.panel.env.open_url")}
                  onClick={() => window.open(remote.url, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="size-3.5" />
                </IconButton>
              </>
            )}
          </Field>
        )}
        <Field label={t("chat.panel.env.computer")}>
          <span className="min-w-0 truncate text-app-micro" title={computer}>
            {computer}
          </span>
        </Field>
        <Field label={t("chat.panel.env.folder")}>
          <span className="min-w-0 truncate font-mono text-app-micro" title={cwd}>
            {cwd}
          </span>
        </Field>
        {branch && (
          <Field label={t("chat.panel.env.branch")}>
            <span className="min-w-0 truncate font-mono text-app-micro" title={branch}>
              {branch}
            </span>
          </Field>
        )}
        {session?.id && (
          <Field label={t("chat.panel.env.session")}>
            <span className="min-w-0 truncate font-mono text-app-micro" title={session.id}>
              {session.id.slice(0, 8)}
            </span>
            <CopyIcon text={session.id} label={t("chat.panel.env.copy_session")} />
            {onForkSession && (
              <IconButton label={t("chat.panel.env.fork_session")} onClick={onForkSession}>
                <GitFork className="size-3.5" />
              </IconButton>
            )}
          </Field>
        )}
        {model.model && (
          <Field label={t("chat.panel.env.model")}>
            <span className="min-w-0 truncate font-mono text-app-micro">{model.model}</span>
          </Field>
        )}
        {codex && model.effort && (
          <Field label={t("chat.codex.commands.status.effort")}>
            <span className="min-w-0 truncate text-app-micro">{model.effort}</span>
          </Field>
        )}
        {version && (
          <Field label={t("chat.panel.env.version")}>
            <span className="font-mono text-app-micro">{version}</span>
          </Field>
        )}
        {(account || onRefreshAccount) && (
          <Field label={t("chat.panel.env.account")}>
            {account && (
              <span className="min-w-0 truncate text-app-micro" title={account}>
                {account}
              </span>
            )}
            {onRefreshAccount && (
              <IconButton
                label={t("chat.panel.env.account_check")}
                disabled={refreshingAccount}
                onClick={() => {
                  setRefreshingAccount(true);
                  void onRefreshAccount()
                    .catch(fail)
                    .finally(() => setRefreshingAccount(false));
                }}
              >
                <RefreshCw className="size-3" />
              </IconButton>
            )}
          </Field>
        )}
        {profile && (
          <Field label={t("chat.panel.env.profile")}>
            <span className="min-w-0 truncate text-app-micro">{profile}</span>
          </Field>
        )}
      </Section>
      <Section
        title={t("chat.panel.context.title")}
        count={percent !== null ? `${percent}%` : undefined}
        reveal={asked("context")}
      >
        {!context ? (
          <div className="text-app-micro text-muted-foreground">
            {contextUsed === undefined
              ? t("chat.panel.context.unknown")
              : t("chat.panel.context.tokens_used", { used: formatTokens(contextUsed) })}
          </div>
        ) : (
          <>
            <Meter percent={percent ?? 0} />
            <div className="text-app-micro text-muted-foreground tabular-nums">
              {t("chat.panel.context.tokens", {
                used: formatTokens(context.usedTokens),
                max: formatTokens(context.maxTokens),
              })}
              {context.freeTokens !== undefined &&
                ` · ${t("chat.panel.context.free", { count: formatTokens(context.freeTokens) })}`}
            </div>
            {context.categories?.map((category) => (
              <Row key={category.name} className="text-app-micro">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {category.name}
                </span>
                <span className="tabular-nums">{formatTokens(category.tokens)}</span>
              </Row>
            ))}
          </>
        )}
        {controls && onCompact && (
          <div className="mt-1">
            <button
              type="button"
              onClick={
                busy
                  ? undefined
                  : () => {
                      setCompacting(true);
                      void Promise.resolve()
                        .then(onCompact)
                        .catch(fail)
                        .finally(() => setCompacting(false));
                    }
              }
              aria-disabled={busy || undefined}
              title={busy ? t("chat.panel.context.compact_busy", { context: agent }) : undefined}
              className={cn(
                "rounded-(--radius-control) border border-border px-2 py-0.5 text-app-ui-sm",
                busy
                  ? "cursor-not-allowed opacity-40"
                  : "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
              )}
            >
              {t("chat.panel.context.compact")}
            </button>
          </div>
        )}
      </Section>
      <Section title={t("chat.panel.usage.title")} reveal={asked("usage")}>
        {cost !== undefined && cost > 0 && (
          <Row className="text-app-micro" title={t("chat.panel.usage.cost_hint")}>
            <span className="min-w-0 flex-1 truncate">{t("chat.panel.usage.cost")}</span>
            <span className="tabular-nums">{formatCost(cost, i18n.language)}</span>
          </Row>
        )}
        {limits.length === 0 ? (
          <div className="text-app-micro text-muted-foreground">{t("chat.panel.usage.none")}</div>
        ) : (
          limits.map((limit) => (
            <div
              key={`${limit.kind}-${limit.scope ?? ""}-${limit.windowMins ?? ""}`}
              className="flex flex-col gap-0.5 py-0.5"
            >
              <Row className="text-app-micro">
                <span className="min-w-0 flex-1 truncate">
                  {usageMeterLabel(t, limit, (usage?.more.length ?? 0) > 0)}
                </span>
                <span className="tabular-nums">{Math.round(limit.percent)}%</span>
              </Row>
              <Meter percent={Math.min(100, limit.percent)} />
              {limit.resetsAt !== undefined && (
                <div className="text-app-micro text-muted-foreground">
                  {t("chat.panel.usage.resets", {
                    time: new Date(limit.resetsAt).toLocaleString(i18n.language, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </Section>
      {goal && (
        <Section title={t("chat.goal.label")}>
          <GoalSummary tab={goal} />
        </Section>
      )}
      <TodosSection todos={todos} />
      <ActivitySections
        activity={activity}
        foldKey={foldKey}
        reveal={reveal?.part === "jobs" ? reveal : undefined}
        onOpen={openRow}
        stopOf={stopOf}
        onBackground={controls ? onBackground : undefined}
        jobDetail={jobDetail}
      />
      <ResultsSection
        items={model.items}
        tools={model.tools}
        cwd={cwd}
        workspaceId={workspaceId}
        rootPath={rootPath}
      />
      <Section
        title={t("chat.panel.changed.title")}
        count={changed.length}
        empty={changed.length === 0}
        folded
        reveal={asked("changes")}
      >
        {changed.map((file) => (
          <ChangedRow
            key={file.path}
            file={{
              path: file.path,
              added: file.added ?? 0,
              removed: file.removed ?? 0,
              created: file.created ?? madeHere.has(file.path),
              toolUseIds: [],
            }}
            cwd={cwd}
            {...(links ? { onOpen: () => links.openChange(file.path) } : {})}
          />
        ))}
      </Section>
      {mcp}
    </aside>
  );
}

export function CodexPanelMcp({
  servers,
  onRefresh,
  onReload,
  onSignIn,
  signInNames,
  signingIn,
  refreshKey,
  reveal,
}: {
  servers?: ChatPanel["mcp"];
  onRefresh?: () => Promise<void>;
  onReload?: () => Promise<void>;
  onSignIn?: (name: string) => Promise<void>;
  signInNames?: readonly string[];
  signingIn?: string;
  refreshKey?: number;
  reveal?: number;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    void action()
      .catch((error: Error) => showToast({ kind: "error", message: error.message }))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  return (
    <Section
      title={t("chat.panel.mcp.title")}
      count={servers?.length}
      folded
      reveal={reveal}
      onOpen={onRefresh ? () => run(onRefresh) : undefined}
      openAgain={refreshKey ?? Boolean(onRefresh)}
    >
      {(onRefresh || onReload) && (
        <Row>
          {onRefresh && (
            <IconButton
              label={t("chat.panel.mcp.refresh")}
              disabled={busy}
              onClick={() => run(onRefresh)}
            >
              <RefreshCw className="size-3" />
            </IconButton>
          )}
          {onReload && (
            <TextButton onClick={() => run(onReload)} disabled={busy}>
              {t("chat.panel.mcp.reload")}
            </TextButton>
          )}
        </Row>
      )}
      {!servers?.length && (
        <div className="text-app-micro text-muted-foreground" role="status">
          {busy
            ? t("chat.panel.mcp.refreshing")
            : t(servers ? "chat.panel.mcp.none" : "chat.panel.mcp.unread")}
        </div>
      )}
      {servers?.map((server) => (
        <Row key={server.name} title={server.name}>
          <span className="min-w-0 flex-1 truncate">{server.name}</span>
          <span className="shrink-0 text-app-micro text-muted-foreground">
            {signingIn === server.name
              ? t("chat.panel.mcp.signing_in")
              : t(`chat.panel.mcp.status.${server.status}`, { defaultValue: server.status })}
          </span>
          {onSignIn &&
            signInNames?.includes(server.name) &&
            server.status === "needs-auth" &&
            !signingIn && (
              <TextButton onClick={() => run(() => onSignIn(server.name))} disabled={busy}>
                {t("chat.panel.mcp.sign_in")}
              </TextButton>
            )}
        </Row>
      ))}
    </Section>
  );
}

/**
 * Its MCP servers as they stand there, as a chat here lists its own; worked
 * as a chat here works them (`controls`): signed in to, connected again,
 * turned on or off.
 */
function RemoteMcp({
  target,
  servers,
  controls,
  reveal,
}: {
  target: RemoteTarget;
  servers: NonNullable<ChatPanel["mcp"]>;
  controls: boolean;
  reveal?: number;
}) {
  const { t } = useTranslation();
  const mcp = usePeerMcp(target);
  const fail = (err: Error) => showToast({ kind: "error", message: err.message });
  return (
    <Section
      title={t("chat.panel.mcp.title")}
      count={servers.length}
      empty={servers.length === 0}
      folded
      reveal={reveal}
    >
      {servers.length === 0 ? (
        <div className="text-app-micro text-muted-foreground">{t("chat.panel.mcp.none")}</div>
      ) : (
        servers.map((server) => {
          const signingIn = mcp.signIn?.server === server.name;
          return (
            <Row
              key={server.name}
              title={signingIn ? t("chat.panel.mcp.signing_in_hint") : server.name}
            >
              <span className="min-w-0 flex-1 truncate">{server.name}</span>
              {signingIn ? (
                <span className="flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground">
                  {t("chat.panel.mcp.signing_in")}
                  <TextButton onClick={mcp.reopen}>{t("chat.panel.mcp.reopen")}</TextButton>
                  <TextButton onClick={mcp.cancel}>{t("chat.panel.mcp.cancel")}</TextButton>
                </span>
              ) : controls && server.status === "needs-auth" ? (
                <TextButton onClick={() => mcp.authenticate(server.name).catch(fail)}>
                  {t("chat.panel.mcp.sign_in")}
                </TextButton>
              ) : (
                <span className="shrink-0 text-app-micro text-muted-foreground">
                  {t(`chat.panel.mcp.status.${server.status}`, { defaultValue: server.status })}
                </span>
              )}
              {controls && server.status !== "disabled" && !signingIn && (
                <IconButton
                  label={t("chat.panel.mcp.reconnect")}
                  onClick={() => mcp.reconnect(server.name).catch(fail)}
                >
                  <RefreshCw className="size-3" />
                </IconButton>
              )}
              {controls && (
                <Switch
                  checked={server.status !== "disabled"}
                  onCheckedChange={(enabled) => mcp.toggle(server.name, enabled).catch(fail)}
                  aria-label={t("chat.panel.mcp.enabled", { name: server.name })}
                />
              )}
            </Row>
          );
        })
      )}
    </Section>
  );
}

/**
 * A background run opened, as a chat here shows one: the command it runs,
 * the end of its output (as it comes, while it runs), how it ended, and its
 * call and its output file a click away. The output is read from that
 * computer, which tells where it is from 0.13.0; before, what the run said
 * last stands for it.
 */
function RemoteJobDetail({
  job,
  tools,
  workspaceId,
  rootPath,
  onShowCall,
  onOpenFile,
}: {
  job: ChatPanel["tasks"][number];
  tools: Record<string, ToolCall>;
  workspaceId: string;
  rootPath: string;
  onShowCall?: ((toolUseId: string) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const running = job.status === "running";
  const command = jobCommand(job, tools);
  const outputFile = job.outputFile;
  const output = useJobOutput(workspaceId, rootPath, outputFile, running);
  const said = running ? job.activity || job.summary : job.summary || job.activity;
  const exitCode = exitCodeOf(job.summary);
  const toolUseId = job.toolUseId;
  const below = outputFile !== undefined || Boolean(said);
  return (
    <div
      className="mt-0.5 mb-1 ml-4 flex flex-col gap-1.5 border-l border-border pl-2 text-app-micro"
      data-testid="remote-job-detail"
    >
      {(command || below) && (
        <div className="overflow-hidden rounded-(--radius-control) border border-border">
          {command && (
            <div
              className={cn(
                "code-hl line-clamp-3 bg-[var(--state-hover-bg)] px-2 py-1 font-mono whitespace-pre-wrap break-all",
                below && "border-b border-border",
              )}
              title={command}
            >
              <span className="text-[var(--state-success-fg)] select-none">$ </span>
              <Highlighted code={command} language="bash" />
            </div>
          )}
          {outputFile !== undefined ? (
            <JobOutputView output={output} />
          ) : (
            said && (
              <div className="line-clamp-6 px-2 py-1.5 whitespace-pre-wrap break-words">{said}</div>
            )
          )}
        </div>
      )}
      <div className="flex min-h-4 items-center gap-1.5 text-muted-foreground">
        {running ? (
          <span className="flex items-center gap-1 text-[var(--state-success-fg)]">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
            {t("chat.panel.jobs.live")}
          </span>
        ) : exitCode !== undefined ? (
          <span className={cn(exitCode !== 0 && "text-[var(--state-error-fg)]")}>
            {t("chat.panel.jobs.exit_code", { code: exitCode })}
          </span>
        ) : outputFile !== undefined && job.summary ? (
          <span className="min-w-0 truncate" title={job.summary}>
            {job.summary}
          </span>
        ) : (
          <span className="truncate font-mono">{job.type}</span>
        )}
        {output && output.sizeBytes > 0 && (
          <span className="ml-auto shrink-0 tabular-nums">{formatBytes(output.sizeBytes)}</span>
        )}
      </div>
      {((toolUseId && onShowCall) || (outputFile && onOpenFile)) && (
        <div className="flex flex-wrap gap-1">
          {toolUseId && onShowCall && (
            <JobButton onClick={() => onShowCall(toolUseId)}>
              <MessageSquare className="size-3" />
              {t("chat.panel.jobs.show_call")}
            </JobButton>
          )}
          {outputFile && onOpenFile && (
            <JobButton onClick={() => onOpenFile(outputFile)} title={outputFile}>
              <FileText className="size-3" />
              {t("chat.panel.jobs.output_file")}
            </JobButton>
          )}
        </div>
      )}
    </div>
  );
}
