import type { TFunction } from "i18next";
import {
  ExternalLink,
  FilePlus,
  FileText,
  GitFork,
  Globe,
  MessageSquare,
  RefreshCw,
  Square,
  SquareCheck,
  SquareDot,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ChatPanel } from "../../../../packages/remote-protocol/src/view";
import { peerOf } from "../../../shared/fs/peer-url";
import { shownPath } from "../../../shared/fs/relative-path";
import { formatBytes } from "../../../shared/util/format-bytes";
import { shortId } from "../../../shared/util/short-id";
import { useNow } from "../../hooks/use-now";
import { artifactsOf } from "../../services/chat/artifact";
import { type LinkedFile, useChatFiles, useLinkRun } from "../../services/chat/chat-files";
import { useFoundFiles } from "../../services/chat/file-presence";
import { type JobOutput, readJobOutput } from "../../services/chat/job-output";
import { linkPlaceIndex, linkPlaces } from "../../services/chat/link-places";
import { grantsOf, linkKey, pathInRoot, useLinksFound } from "../../services/chat/linked-files";
import { fileKind } from "../../services/chat/links";
import type { ChatItem, ChatModel, ToolCall } from "../../services/chat/model";
import { modelLineOfTab } from "../../services/chat/model-line";
import {
  type AgentRow,
  type AgentStatus,
  agentsOf,
  type ChangedFile,
  changedFilesOf,
  distinctResults,
  exitCodeOf,
  jobCommand,
  type ResultEntry,
  resultHref,
  resultSource,
  resultsOf,
} from "../../services/chat/panel";
import { type ActivityRow, activityOf, type JobLike } from "../../services/chat/running";
import { formatTokens } from "../../services/chat/usage-line";
import { cn } from "../../utils/cn";
import { usageLineOf } from "../agent-view/remote-usage";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
import { CopyButton } from "../ui/copy-button";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";
import { showToast } from "../ui/toast";
import { ArtifactRow } from "./artifact-card";
import { LinkMenu, useChatLinks } from "./chat-links";
import { Highlighted } from "./code-highlight";
import { FileKindIcon } from "./file-kind-icon";
import { GoalSummary, type TabGoal } from "./goal-bar";
import { FirstFew, Row, Section } from "./panel-section";
import { ActivitySections } from "./running-section";
import { Meter, UsageMeterRow, usageMeterKey } from "./usage-meter-row";

export { Meter } from "./usage-meter-row";

const NO_JOBS: ChatPanel["tasks"] = [];

export type RemotePanelPart = "status" | "context" | "usage" | "jobs" | "changes" | "mcp";

export interface RemotePanelAsk {
  part: RemotePanelPart;
  seq: number;
  id?: string;
}

const AGENT_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed", "stopped"]);

export function remoteAgentsOf(panel: ChatPanel | undefined, model: ChatModel): AgentRow[] {
  const known = new Map(agentsOf(model).map((row) => [row.toolUseId, row]));
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

export interface PanelScope {
  agent: "claude" | "codex";
  foldKey: string;
  computer: string;
  cwd: string;
  rootPath: string;
  workspaceId: string;
  profile?: string;
}

export interface PanelNeedsVersion {
  context?: string;
  usage?: string;
  stop?: string;
}

export interface SessionPanelProps {
  scope: PanelScope;
  panel: ChatPanel | undefined;
  model: ChatModel;
  history?: { items: ChatItem[]; tools: Record<string, ToolCall> } | null;
  agents?: readonly AgentRow[];
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
  onSectionOpen?: (part: "usage") => void;
  openAgain?: boolean;
  needsVersion?: PanelNeedsVersion;
  reveal?: RemotePanelAsk | null;
  onRevealed?: (seq: number) => void;
  goal?: TabGoal | null;
  signedOut?: boolean;
  contextUsed?: number;
  branch?: string | null;
  mcp?: React.ReactNode;
  conversations?: React.ReactNode;
  className?: string;
  testId?: string;
}

export function SessionSidePanel({
  scope,
  panel,
  model,
  history,
  agents: givenAgents,
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
  onSectionOpen,
  openAgain,
  needsVersion,
  reveal,
  onRevealed,
  goal,
  signedOut,
  contextUsed,
  branch,
  mcp,
  conversations,
  className,
  testId,
}: SessionPanelProps) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const { foldKey, cwd, rootPath, workspaceId } = scope;
  const agents = useMemo(
    () => givenAgents ?? [...remoteAgentsOf(panel, model), ...runs],
    [givenAgents, panel, model, runs],
  );
  const jobs = panel?.tasks ?? NO_JOBS;
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
  const items = useMemo(
    () => (history ? [...history.items, ...model.items] : model.items),
    [history, model.items],
  );
  const tools = useMemo(
    () => (history ? { ...history.tools, ...model.tools } : model.tools),
    [history, model.tools],
  );
  const asked = (part: RemotePanelPart) => (reveal?.part === part ? reveal.seq : undefined);
  const latest = useRef({ tools, controls, onShowAgent, onShowCall, onStopTask, onStopRun });
  latest.current = { tools, controls, onShowAgent, onShowCall, onStopTask, onStopRun };
  const openRow = useCallback((row: ActivityRow) => {
    const { onShowAgent, onShowCall } = latest.current;
    if (row.agent) onShowAgent(row.agent.toolUseId);
    else if (row.call) onShowCall?.(row.call.id);
  }, []);
  const stopOf = useCallback(
    (row: ActivityRow): (() => void) | undefined => {
      const { controls, onStopTask, onStopRun } = latest.current;
      if (!controls || row.status !== "running") return undefined;
      const run = row.agent?.run;
      if (run) return onStopRun && (() => onStopRun(run.id));
      const taskId =
        row.job?.taskId ??
        row.agent?.taskId ??
        Object.values(model.tasks).find((task) => task.toolUseId === row.key)?.taskId;
      return taskId && onStopTask ? () => onStopTask(taskId) : undefined;
    },
    [model.tasks],
  );
  const jobDetail = useCallback(
    (job: JobLike) => (
      <JobDetail
        job={job as ChatPanel["tasks"][number]}
        tools={latest.current.tools}
        workspaceId={workspaceId}
        rootPath={rootPath}
        onShowCall={latest.current.onShowCall}
        onOpenFile={links?.openFile}
      />
    ),
    [workspaceId, rootPath, links],
  );

  return (
    <aside
      className={cn("app-scrollbar flex flex-col overflow-y-auto bg-background", className)}
      aria-label={t("chat.panel.aria")}
      data-testid={testId}
    >
      <PanelEnv
        scope={scope}
        panel={panel}
        model={model}
        controls={controls}
        branch={branch}
        signedOut={signedOut}
        onRemoteControl={onRemoteControl}
        onForkSession={onForkSession}
        onRefreshAccount={onRefreshAccount}
        reveal={asked("status")}
        onRevealed={onRevealed}
      />
      <PanelContext
        agent={scope.agent}
        panel={panel}
        busy={model.running}
        controls={controls}
        contextUsed={contextUsed}
        needsVersion={needsVersion?.context}
        onCompact={onCompact}
        reveal={asked("context")}
        onRevealed={onRevealed}
      />
      <PanelUsage
        panel={panel}
        needsVersion={needsVersion?.usage}
        onOpen={onSectionOpen ? () => onSectionOpen("usage") : undefined}
        openAgain={openAgain}
        reveal={asked("usage")}
        onRevealed={onRevealed}
      />
      <PanelGoal goal={goal} />
      <TodosSection todos={panel?.todos ?? []} />
      <ActivitySections
        activity={activity}
        foldKey={foldKey}
        reveal={reveal?.part === "jobs" ? reveal : undefined}
        onRevealed={onRevealed}
        onOpen={openRow}
        stopOf={stopOf}
        stopNote={needsVersion?.stop}
        onBackground={controls ? onBackground : undefined}
        jobDetail={jobDetail}
      />
      {conversations}
      <ResultsSection
        items={items}
        tools={tools}
        cwd={cwd}
        workspaceId={workspaceId}
        rootPath={rootPath}
      />
      <PanelChanged
        panel={panel}
        tools={tools}
        cwd={cwd}
        workspaceId={workspaceId}
        reveal={asked("changes")}
        onRevealed={onRevealed}
      />
      {mcp}
    </aside>
  );
}

function shownAccount(
  t: TFunction,
  agent: PanelScope["agent"],
  account: string | undefined,
  signedOut: boolean | undefined,
): string | undefined {
  if (signedOut) return t("chat.codex.commands.status.signed_out");
  if (agent !== "codex") return account;
  if (account === "apiKey" || account === "apikey") return t("chat.panel.env.api_key");
  if (account === "chatgpt" || account === "chatgptAuthTokens") return "ChatGPT";
  if (account === "unknown") return t("chat.panel.env.account_unknown");
  return account;
}

export function PanelEnv({
  scope,
  panel,
  model,
  controls,
  branch,
  signedOut,
  onRemoteControl,
  onForkSession,
  onRefreshAccount,
  reveal,
  onRevealed,
}: {
  scope: PanelScope;
  panel: ChatPanel | undefined;
  model: ChatModel;
  controls: boolean;
  branch?: string | null;
  signedOut?: boolean;
  onRemoteControl?: (enabled: boolean) => Promise<void>;
  onForkSession?: () => void;
  onRefreshAccount?: () => Promise<void>;
  reveal?: number;
  onRevealed?: (seq: number) => void;
}) {
  const { t } = useTranslation();
  const { computer, cwd, profile } = scope;
  const modelLine = modelLineOfTab(model);
  const session = panel?.session;
  const version = session?.version ?? model.version;
  const account = shownAccount(t, scope.agent, session?.account, signedOut);
  const [refreshingAccount, setRefreshingAccount] = useState(false);
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
    <Section title={t("chat.panel.env.title")} reveal={reveal} onRevealed={onRevealed}>
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
              <span className="min-w-0 flex-1 truncate font-mono text-app-micro" title={remote.url}>
                {remote.url}
              </span>
              <CopyButton text={remote.url} label={t("chat.panel.env.copy_url")} />
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
            {shortId(session.id)}
          </span>
          <CopyButton text={session.id} label={t("chat.panel.env.copy_session")} />
          {onForkSession && (
            <IconButton label={t("chat.panel.env.fork_session")} onClick={onForkSession}>
              <GitFork className="size-3.5" />
            </IconButton>
          )}
        </Field>
      )}
      {modelLine && (
        <Field label={t("chat.panel.env.model")}>
          <span className="min-w-0 truncate font-mono text-app-micro" title={modelLine}>
            {modelLine}
          </span>
        </Field>
      )}
      {version && (
        <Field label={t("chat.panel.env.version")}>
          <span className="min-w-0 truncate font-mono text-app-micro">{version}</span>
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
                  .catch((error: Error) => showToast({ kind: "error", message: error.message }))
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
  );
}

export function PanelContext({
  agent,
  panel,
  busy: running,
  controls,
  contextUsed,
  needsVersion,
  onCompact,
  reveal,
  onRevealed,
}: {
  agent: PanelScope["agent"];
  panel: ChatPanel | undefined;
  busy: boolean;
  controls: boolean;
  contextUsed?: number;
  needsVersion?: string;
  onCompact?: () => void | Promise<void>;
  reveal?: number;
  onRevealed?: (seq: number) => void;
}) {
  const { t } = useTranslation();
  const context = panel?.context ?? null;
  const percent =
    context && context.maxTokens > 0
      ? Math.min(100, Math.round((context.usedTokens / context.maxTokens) * 100))
      : null;
  const [compacting, setCompacting] = useState(false);
  const busy = running || compacting;
  return (
    <Section
      title={t("chat.panel.context.title")}
      count={percent !== null ? `${percent}%` : undefined}
      reveal={reveal}
      onRevealed={onRevealed}
    >
      {needsVersion ? (
        <div className="text-app-micro text-muted-foreground">
          {t("chat.panel.needs_version", { version: needsVersion })}
        </div>
      ) : !context ? (
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
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{category.name}</span>
              <span className="shrink-0 tabular-nums">{formatTokens(category.tokens)}</span>
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
                      .catch((error: Error) => showToast({ kind: "error", message: error.message }))
                      .finally(() => setCompacting(false));
                  }
            }
            aria-disabled={busy || undefined}
            title={busy ? t("chat.panel.context.compact_busy", { context: agent }) : undefined}
            className={cn(
              "rounded-(--radius-control) border border-border px-2 py-0.5 text-app-ui-sm whitespace-nowrap",
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
  );
}

export function PanelUsage({
  panel,
  needsVersion,
  onOpen,
  openAgain,
  reveal,
  onRevealed,
}: {
  panel: ChatPanel | undefined;
  needsVersion?: string;
  onOpen?: () => void;
  openAgain?: boolean;
  reveal?: number;
  onRevealed?: (seq: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow(true, 60_000);
  const usage = usageLineOf(panel, now);
  const limits = usage ? [...usage.meters, ...usage.more] : [];
  const cost = panel?.costUsd;
  return (
    <Section
      title={t("chat.panel.usage.title")}
      onOpen={onOpen}
      openAgain={openAgain}
      reveal={reveal}
      onRevealed={onRevealed}
    >
      {cost !== undefined && cost > 0 && (
        <Row className="text-app-micro" title={t("chat.panel.usage.cost_hint")}>
          <span className="min-w-0 flex-1 truncate">{t("chat.panel.usage.cost")}</span>
          <span className="shrink-0 tabular-nums" data-testid="chat-panel-cost">
            {formatCost(cost, i18n.language)}
          </span>
        </Row>
      )}
      {needsVersion ? (
        <div className="text-app-micro text-muted-foreground">
          {t("chat.panel.needs_version", { version: needsVersion })}
        </div>
      ) : limits.length === 0 ? (
        <div className="text-app-micro text-muted-foreground">{t("chat.panel.usage.none")}</div>
      ) : (
        limits.map((limit) => (
          <UsageMeterRow
            key={usageMeterKey(limit)}
            meter={limit}
            scoped={(usage?.more.length ?? 0) > 0}
          />
        ))
      )}
    </Section>
  );
}

export function PanelGoal({ goal }: { goal: TabGoal | null | undefined }) {
  const { t } = useTranslation();
  if (!goal) return null;
  return (
    <Section title={t("chat.goal.label")}>
      <GoalSummary tab={goal} />
    </Section>
  );
}

export function PanelChanged({
  panel,
  tools,
  cwd,
  workspaceId,
  reveal,
  onRevealed,
}: {
  panel: ChatPanel | undefined;
  tools: Record<string, ToolCall>;
  cwd: string;
  workspaceId: string;
  reveal?: number;
  onRevealed?: (seq: number) => void;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const changed = panel?.changedFiles ?? [];
  const peer = peerOf(workspaceId);
  const changesByPath = useMemo(
    () => new Map(changedFilesOf(tools).map((file) => [file.path, file])),
    [tools],
  );
  return (
    <Section
      title={t("chat.panel.changed.title")}
      count={changed.length}
      empty={changed.length === 0}
      folded
      reveal={reveal}
      onRevealed={onRevealed}
    >
      {changed.map((file) => {
        const change = changesByPath.get(file.path);
        return (
          <ChangedRow
            key={file.path}
            file={{
              path: file.path,
              rawPath: peer ? file.rawPath : change?.rawPath,
              added: file.added ?? 0,
              removed: file.removed ?? 0,
              created: file.created ?? change?.created ?? false,
              toolUseIds: [],
            }}
            cwd={cwd}
            {...(links ? { onOpen: () => links.openChange(file.path) } : {})}
          />
        );
      })}
    </Section>
  );
}

export function TodosSection({
  todos,
}: {
  todos: readonly { id?: string; content: string; status: string }[];
}) {
  const { t } = useTranslation();
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <Section
      title={t("chat.panel.todos.title")}
      count={todos.length > 0 ? `${done}/${todos.length}` : 0}
      empty={todos.length === 0}
    >
      {todos.map((todo, i) => (
        <Row key={todo.id ?? i}>
          {todo.status === "completed" ? (
            <SquareCheck
              aria-label={t("chat.panel.todos.completed")}
              className="size-3.5 shrink-0 text-[var(--state-success-fg)]"
            />
          ) : todo.status === "in_progress" ? (
            <SquareDot
              aria-label={t("chat.panel.todos.in_progress")}
              className="size-3.5 shrink-0 text-[var(--tab-claude-running-fg)]"
            />
          ) : (
            <Square
              aria-label={t("chat.panel.todos.pending")}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 break-words",
              todo.status === "completed" && "text-muted-foreground line-through",
              todo.status === "in_progress" && "font-medium text-foreground",
            )}
          >
            {todo.content}
          </span>
        </Row>
      ))}
    </Section>
  );
}

export function ResultsSection({
  items,
  tools,
  cwd,
  workspaceId,
  rootPath,
}: {
  items: ChatItem[];
  tools: Record<string, ToolCall>;
  cwd: string;
  workspaceId: string;
  rootPath: string;
}) {
  const { t } = useTranslation();
  const named = useMemo(() => resultsOf(items, tools, cwd), [items, tools, cwd]);
  const grants = grantsOf(useChatFiles());
  const inRun = useLinkRun();
  const viaHost = useMemo(() => {
    const out = new Map<string, LinkedFile>();
    if (!grants) return out;
    for (const result of named) {
      const source = result.kind === "file" ? resultSource(result) : undefined;
      if (source && pathInRoot(result.target, cwd, rootPath) === null) {
        out.set(result.target, inRun({ href: resultHref(result), source }));
      }
    }
    return out;
  }, [grants, named, cwd, rootPath, inRun]);
  const asked = useMemo(() => (grants ? [...viaHost.values()] : null), [grants, viaHost]);
  const resolved = useLinksFound(asked);
  const filePlaces = useMemo(() => {
    const index = linkPlaceIndex(tools, cwd);
    const places = new Map<string, string[]>();
    for (const result of named) {
      if (result.kind !== "file" || viaHost.has(result.target)) continue;
      const paths = linkPlaces(result.target, index).map((place) => place.path);
      if (paths.length > 0) places.set(result.target, paths);
    }
    return places;
  }, [named, tools, cwd, viaHost]);
  const lookedUp = useMemo(() => [...new Set([...filePlaces.values()].flat())], [filePlaces]);
  const toolsDone = useMemo(
    () =>
      Object.values(tools).filter((t) => t.status !== "running" && t.status !== "streaming").length,
    [tools],
  );
  const found = useFoundFiles(workspaceId, rootPath, lookedUp, toolsDone);
  const { filePaths, bare, unread } = useMemo(() => {
    const paths = new Map<string, string>();
    const bare = new Set<string>();
    const unread = new Set<string>();
    for (const [target, places] of filePlaces) {
      const path = places.find((place) => found.has(place));
      if (path) paths.set(target, path);
    }
    for (const [target, link] of viaHost) {
      const state = resolved?.get(linkKey(link));
      if (state === undefined || state === null) continue;
      if (state !== "failed" && "path" in state) {
        paths.set(target, state.path);
        if (!state.readable) bare.add(target);
      } else {
        paths.set(target, target);
        bare.add(target);
        if (state === "failed") unread.add(target);
      }
    }
    return { filePaths: paths, bare, unread };
  }, [filePlaces, found, viaHost, resolved]);
  const results = useMemo(
    () =>
      distinctResults(
        named.filter((result) => result.kind !== "file" || filePaths.has(result.target)),
        cwd,
        (target) => filePaths.get(target) ?? null,
      ),
    [named, filePaths, cwd],
  );
  const artifacts = useMemo(() => artifactsOf(tools, cwd).reverse(), [tools, cwd]);
  const made = useMemo(() => {
    const pages = new Set(artifacts.flatMap((page) => (page.url ? [page.url] : [])));
    return results
      .filter((result) => !(result.kind === "url" && pages.has(result.target)))
      .reverse();
  }, [artifacts, results]);
  const links = useChatLinks();
  const open = (target: string, kind: ResultEntry["kind"]) => {
    const link = viaHost.get(target);
    if (kind === "file") links?.openFile(target, link ? { link } : undefined);
    else links?.openUrl(target);
  };
  return (
    <Section
      title={t("chat.panel.results.title")}
      count={made.length + artifacts.length}
      empty={made.length + artifacts.length === 0}
    >
      <FirstFew>
        {[
          ...artifacts.map((page) => (
            <ArtifactRow
              key={page.url ?? page.file}
              page={page}
              workspaceId={workspaceId}
              rootPath={rootPath}
            />
          )),
          ...made.map((result) => (
            <ResultRow
              key={result.target}
              result={result}
              path={filePaths.get(result.target) ?? null}
              link={viaHost.get(result.target)}
              bare={bare.has(result.target)}
              unread={unread.has(result.target)}
              cwd={cwd}
              workspaceId={workspaceId}
              onOpen={() => open(result.target, result.kind)}
            />
          )),
        ]}
      </FirstFew>
    </Section>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-2 text-app-ui-sm">
      <span className="w-14 shrink-0 truncate text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  );
}

const OUTPUT_POLL_MS = 1000;
const OUTPUT_TRIES = 5;

export function useJobOutput(
  workspaceId: string,
  rootPath: string,
  path: string | undefined,
  live: boolean,
): JobOutput | null | undefined {
  const [output, setOutput] = useState<JobOutput | null | undefined>(undefined);
  useEffect(() => {
    if (!path) {
      setOutput(null);
      return;
    }
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const read = async () => {
      const got = await readJobOutput(workspaceId, rootPath, path);
      if (gone) return;
      tries = got ? 0 : tries + 1;
      if (got || tries >= OUTPUT_TRIES) setOutput((prev) => (sameOutput(prev, got) ? prev : got));
      if (live || (!got && tries < OUTPUT_TRIES)) timer = setTimeout(read, OUTPUT_POLL_MS);
    };
    void read();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [workspaceId, rootPath, path, live]);
  return output;
}

function sameOutput(a: JobOutput | null | undefined, b: JobOutput | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.sizeBytes === b.sizeBytes &&
    a.cut === b.cut &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}

export function JobOutputView({ output }: { output: JobOutput | null | undefined }) {
  const { t } = useTranslation();
  const outRef = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: to its end each time the output changes
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [output]);
  return output && output.lines.length > 0 ? (
    <pre
      ref={outRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className="app-scrollbar m-0 max-h-48 overflow-auto px-2 py-1.5 font-mono leading-4 whitespace-pre"
      data-testid="chat-job-output"
    >
      {output.cut && (
        <span className="text-muted-foreground select-none">
          {t("chat.panel.jobs.earlier")}
          {"\n"}
        </span>
      )}
      {output.lines.join("\n")}
    </pre>
  ) : (
    <div className="px-2 py-1.5 text-muted-foreground">
      {output === undefined
        ? t("chat.panel.jobs.reading")
        : output === null
          ? t("chat.panel.jobs.unreadable")
          : t("chat.panel.jobs.no_output")}
    </div>
  );
}

export function JobButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex items-center gap-1 whitespace-nowrap rounded-(--radius-control) border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
    >
      {children}
    </button>
  );
}

function ResultRow({
  result,
  path,
  link,
  bare = false,
  unread = false,
  cwd,
  workspaceId,
  onOpen,
}: {
  result: ResultEntry;
  path: string | null;
  link?: LinkedFile;
  bare?: boolean;
  unread?: boolean;
  cwd: string;
  workspaceId: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const label = path ? shownPath(path, cwd) : result.target;
  const [hover, setHover] = useState<DOMRect | null>(null);
  const image = path !== null && !bare && fileKind(path) === "image";
  return (
    <>
      <LinkMenu target={path ?? result.target} href={result.target} kind={result.kind} link={link}>
        <button
          type="button"
          onClick={onOpen}
          onMouseEnter={
            image ? (event) => setHover(event.currentTarget.getBoundingClientRect()) : undefined
          }
          onMouseLeave={image ? () => setHover(null) : undefined}
          title={path ?? result.target}
          className="flex min-h-6 min-w-0 items-center gap-2 rounded-(--radius-control) px-1 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
        >
          {result.kind === "url" ? (
            <Globe className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileKindIcon
              path={path ?? result.target}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {unread && (
            <span className="shrink-0 text-app-micro text-muted-foreground">
              {t("chat.links.load_failed")}
            </span>
          )}
          {result.created && (
            <span className="shrink-0 text-app-micro text-muted-foreground">
              {t("chat.panel.results.created")}
            </span>
          )}
        </button>
      </LinkMenu>
      {hover && path && <Thumbnail workspaceId={workspaceId} path={path} near={hover} />}
    </>
  );
}

const THUMB_PX = 192;

function Thumbnail({
  workspaceId,
  path,
  near,
}: {
  workspaceId: string;
  path: string;
  near: DOMRect;
}) {
  const file = useWorkspaceFile(workspaceId, path);
  if (file.kind !== "inside") return null;
  const top = Math.max(
    8,
    Math.min(near.top - THUMB_PX / 2 + near.height / 2, window.innerHeight - THUMB_PX - 8),
  );
  return createPortal(
    <div
      className="pointer-events-none fixed z-(--layer-floating) rounded-(--radius-raised) border border-border bg-popover p-1"
      style={{ top, right: window.innerWidth - near.left + 8 }}
    >
      <img
        src={file.url}
        alt=""
        className="block object-contain"
        style={{ maxWidth: THUMB_PX, maxHeight: THUMB_PX }}
      />
    </div>,
    document.body,
  );
}

export function ChangedRow({
  file,
  cwd,
  onOpen,
}: {
  file: ChangedFile;
  cwd: string;
  onOpen?: () => void;
}) {
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})}
      title={file.path}
      className={cn(
        "flex min-h-6 min-w-0 items-center gap-2 rounded-(--radius-control) px-1 text-left text-app-ui-sm",
        onOpen && "hover:bg-[var(--state-hover-bg)]",
      )}
    >
      {file.created ? (
        <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-app-micro">
        {shownPath(file.rawPath ?? file.path, cwd)}
      </span>
      <span className="shrink-0 text-app-micro tabular-nums text-[var(--git-status-added-fg)]">
        +{file.added}
      </span>
      <span className="shrink-0 text-app-micro tabular-nums text-[var(--git-status-deleted-fg)]">
        −{file.removed}
      </span>
    </Tag>
  );
}

export function formatCost(usd: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: usd < 1 ? 4 : 2,
  }).format(usd);
}

export function TextButton({
  onClick,
  children,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 whitespace-nowrap rounded-(--radius-control) px-1 text-app-micro text-primary disabled:opacity-40 hover:bg-[var(--state-hover-bg)]"
    >
      {children}
    </button>
  );
}
function JobDetail({
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
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[var(--state-success-fg)]">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
            {t("chat.panel.jobs.live")}
          </span>
        ) : exitCode !== undefined ? (
          <span
            className={cn("whitespace-nowrap", exitCode !== 0 && "text-[var(--state-error-fg)]")}
          >
            {t("chat.panel.jobs.exit_code", { code: exitCode })}
          </span>
        ) : outputFile !== undefined && job.summary ? (
          <span className="min-w-0 truncate" title={job.summary}>
            {job.summary}
          </span>
        ) : (
          <span className="min-w-0 truncate font-mono">{job.type}</span>
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
