// A Claude tab's side panel: where the session runs, how full its context
// is, the agents and tasks it runs, the to-do list Claude keeps, and what
// it made. Folded at the end: the files it changed, the plan's usage and
// the MCP servers. What only a request tells is asked for when the panel
// opens and after each turn.

import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Copy,
  ExternalLink,
  FileImage,
  FilePlus,
  FileText,
  GitFork,
  Globe,
  RefreshCw,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatController } from "../../services/chat/controller";
import {
  type AgentRow,
  agentsOf,
  type ChangedFile,
  changedFilesOf,
  contextOf,
  jobsOf,
  type ResultEntry,
  resultsOf,
  todosOf,
  usageLimitsOf,
} from "../../services/chat/panel";
import type { ChatTabState } from "../../services/chat/store";
import { firstVersionOf } from "../../services/chat/versions";
import { openOrRevealEditor } from "../../services/editor";
import { classifyLinkHref } from "../../services/editor/preview/link-router";
import { useGitStore } from "../../state/stores/git";
import { copyText } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import { Switch } from "../ui/switch";
import { showToast } from "../ui/toast";
import { StatusDot } from "./agent-strip";

interface SidePanelProps {
  controller: ChatController;
  state: ChatTabState;
  workspaceId: string;
  cwd: string;
  rootPath: string;
  onShowAgent: (toolUseId: string) => void;
  /** Opens a new Claude tab from the whole session. */
  onForkSession: () => void;
  className?: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

export function SidePanel({
  controller,
  state,
  workspaceId,
  cwd,
  rootPath,
  onShowAgent,
  onForkSession,
  className,
}: SidePanelProps) {
  const { t } = useTranslation();
  const { model, history } = state;
  const ready = state.phase === "ready" && model.process === "running";

  // The context after each turn, and when the program comes up.
  useEffect(() => {
    if (ready && !model.running) controller.refreshPanel(["context"]);
  }, [controller, ready, model.running]);

  const tools = useMemo(
    () => (history ? { ...history.tools, ...model.tools } : model.tools),
    [history, model.tools],
  );
  const items = useMemo(
    () => (history ? [...history.items, ...model.items] : model.items),
    [history, model.items],
  );
  const agents = useMemo(() => agentsOf(model), [model]);
  const jobs = useMemo(() => jobsOf(model), [model]);
  const todos = useMemo(() => todosOf(tools), [tools]);
  const changed = useMemo(() => changedFilesOf(tools), [tools]);
  const results = useMemo(() => resultsOf(items, tools), [items, tools]);
  const anyRunning =
    agents.some((a) => a.status === "running") || jobs.some((j) => j.status === "running");
  const now = useTicker(anyRunning);

  const open = (target: string, kind: ResultEntry["kind"]) =>
    openTarget(target, kind, { workspaceId, cwd, rootPath, outside: t("chat.panel.outside") });

  return (
    <aside
      className={cn("app-scrollbar flex flex-col overflow-y-auto bg-background", className)}
      aria-label={t("chat.panel.aria")}
      data-testid="chat-side-panel"
    >
      <EnvSection
        controller={controller}
        state={state}
        workspaceId={workspaceId}
        cwd={cwd}
        rootPath={rootPath}
        onForkSession={onForkSession}
      />
      <ContextSection controller={controller} state={state} />
      {agents.length > 0 && (
        <Section title={t("chat.panel.agents.title")} count={agents.length}>
          {agents.map((agent) => (
            <AgentEntry
              key={agent.toolUseId}
              agent={agent}
              now={now}
              onOpen={() => onShowAgent(agent.toolUseId)}
              onStop={
                agent.status === "running" && agent.taskId
                  ? () => stop(controller, agent.taskId as string, t("chat.panel.stop_failed"))
                  : undefined
              }
            />
          ))}
        </Section>
      )}
      {jobs.length > 0 && (
        <Section title={t("chat.panel.jobs.title")} count={jobs.length}>
          {jobs.map((job) => (
            <Row key={job.taskId} title={job.summary || job.description}>
              <StatusDot status={job.status} />
              <span className="min-w-0 flex-1 truncate">{job.description || job.taskId}</span>
              <Elapsed from={job.startedAt} to={job.endedAt} now={now} />
              {job.status === "running" && (
                <IconButton
                  label={t("chat.panel.stop")}
                  onClick={() => stop(controller, job.taskId, t("chat.panel.stop_failed"))}
                >
                  <Square className="size-3" />
                </IconButton>
              )}
            </Row>
          ))}
        </Section>
      )}
      {todos.length > 0 && (
        <Section
          title={t("chat.panel.todos.title")}
          count={`${todos.filter((todo) => todo.status === "completed").length}/${todos.length}`}
        >
          {todos.map((todo) => (
            <Row key={todo.id}>
              {todo.status === "completed" ? (
                <CircleCheck className="size-3.5 shrink-0 text-[var(--git-status-added-fg)]" />
              ) : todo.status === "in_progress" ? (
                <CircleDot className="size-3.5 shrink-0 text-[var(--tab-claude-running-fg)]" />
              ) : (
                <Circle className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 break-words",
                  todo.status === "completed" && "text-muted-foreground line-through",
                )}
              >
                {todo.content}
              </span>
            </Row>
          ))}
        </Section>
      )}
      {results.length > 0 && (
        <Section title={t("chat.panel.results.title")} count={results.length}>
          {results.map((result) => (
            <ResultRow
              key={result.target}
              result={result}
              cwd={cwd}
              onOpen={() => open(result.target, result.kind)}
            />
          ))}
        </Section>
      )}
      {changed.length > 0 && (
        <Section title={t("chat.panel.changed.title")} count={changed.length} folded>
          {changed.map((file) => (
            <ChangedRow
              key={file.path}
              file={file}
              cwd={cwd}
              onOpen={() => open(file.path, "file")}
            />
          ))}
        </Section>
      )}
      <UsageSection controller={controller} state={state} />
      <McpSection controller={controller} state={state} />
    </aside>
  );
}

function stop(controller: ChatController, taskId: string, failed: string): void {
  controller.stopTask(taskId).catch((err: Error) => {
    showToast({ kind: "error", message: `${failed}: ${err.message}` });
  });
}

function openTarget(
  target: string,
  kind: ResultEntry["kind"],
  ctx: { workspaceId: string; cwd: string; rootPath: string; outside: string },
): void {
  const classified = classifyLinkHref(kind === "file" ? encodePath(target) : target, {
    currentFileAbsPath: `${ctx.cwd.replace(/\/$/, "")}/.chat`,
    workspaceRootAbsPath: ctx.rootPath,
    kind: "link",
  });
  if (classified.kind === "external") {
    window.open(classified.href, "_blank", "noopener,noreferrer");
  } else if (classified.kind === "internal-file") {
    openOrRevealEditor(
      { workspaceId: ctx.workspaceId, filePath: classified.absPath },
      { preview: true },
    );
  } else {
    showToast({ kind: "info", message: ctx.outside });
  }
}

/** A path as a link's href, which the classifier decodes. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** A path from the session's folder, when it is under it. */
function shortPath(path: string, cwd: string): string {
  const base = cwd.replace(/\/$/, "");
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function Section({
  title,
  count,
  folded = false,
  onOpen,
  children,
}: {
  title: string;
  count?: number | string;
  /** Starts folded. */
  folded?: boolean;
  /** Called each time the section opens. */
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!folded);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked for each time it opens, not when the callback changes
  useEffect(() => {
    if (open) onOpen?.();
  }, [open]);
  return (
    <section className="border-b border-border px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 text-left text-app-ui-sm text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="font-medium">{title}</span>
        {count !== undefined && <span className="ml-auto tabular-nums">{count}</span>}
      </button>
      {open && <div className="mt-1.5 flex flex-col gap-0.5">{children}</div>}
    </section>
  );
}

function Row({
  title,
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-6 items-center gap-2 text-app-ui-sm", className)} title={title}>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-2 text-app-ui-sm">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      title={label}
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        "shrink-0 rounded-(--radius-control) p-1 text-muted-foreground",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function CopyIcon({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={label}
      onClick={() => {
        copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <CircleCheck className="size-3.5" /> : <Copy className="size-3.5" />}
    </IconButton>
  );
}

function EnvSection({
  controller,
  state,
  workspaceId,
  cwd,
  rootPath,
  onForkSession,
}: {
  controller: ChatController;
  state: ChatTabState;
  workspaceId: string;
  cwd: string;
  rootPath: string;
  onForkSession: () => void;
}) {
  const { t } = useTranslation();
  const { model } = state;
  const branch = useGitStore((s) => {
    const session = s.sessions.get(workspaceId);
    return session?.branchInfo?.current ?? session?.status?.branch?.current ?? null;
  });
  const underRoot = cwd === rootPath || cwd.startsWith(`${rootPath.replace(/\/$/, "")}/`);
  const remote = model.remoteControl;
  const [switching, setSwitching] = useState(false);
  const canRemote =
    model.init?.remoteControl === true &&
    state.phase === "ready" &&
    model.process === "running" &&
    !switching;
  const onRemote = (enabled: boolean) => {
    setSwitching(true);
    controller
      .setRemoteControl(enabled)
      .catch((err: Error) => {
        showToast({
          kind: "error",
          message: t("chat.panel.env.remote_failed", { error: err.message }),
        });
      })
      .finally(() => setSwitching(false));
  };
  return (
    <Section title={t("chat.panel.env.title")}>
      <Field label={t("chat.panel.env.remote_control")}>
        <Switch
          checked={remote?.enabled === true}
          disabled={!canRemote}
          onCheckedChange={onRemote}
          aria-label={t("chat.panel.env.remote_control")}
          title={
            model.init && !model.init.remoteControl
              ? t("chat.panel.env.remote_unavailable")
              : undefined
          }
        />
        {remote?.enabled && remote.sessionUrl && (
          <>
            <span
              className="min-w-0 flex-1 truncate font-mono text-app-micro"
              title={remote.sessionUrl}
            >
              {remote.sessionUrl}
            </span>
            <CopyIcon text={remote.sessionUrl} label={t("chat.panel.env.copy_url")} />
            <IconButton
              label={t("chat.panel.env.open_url")}
              onClick={() => window.open(remote.sessionUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="size-3.5" />
            </IconButton>
          </>
        )}
      </Field>
      <Field label={t("chat.panel.env.folder")}>
        <span className="min-w-0 truncate font-mono text-app-micro" title={cwd}>
          {cwd}
        </span>
      </Field>
      {branch && underRoot && (
        <Field label={t("chat.panel.env.branch")}>
          <span className="min-w-0 truncate font-mono text-app-micro" title={branch}>
            {branch}
          </span>
        </Field>
      )}
      {model.sessionId && (
        <Field label={t("chat.panel.env.session")}>
          <span className="min-w-0 truncate font-mono text-app-micro" title={model.sessionId}>
            {model.sessionId.slice(0, 8)}
          </span>
          <CopyIcon text={model.sessionId} label={t("chat.panel.env.copy_session")} />
          <IconButton label={t("chat.panel.env.fork_session")} onClick={onForkSession}>
            <GitFork className="size-3.5" />
          </IconButton>
        </Field>
      )}
      {model.model && (
        <Field label={t("chat.panel.env.model")}>
          <span className="min-w-0 truncate font-mono text-app-micro">{model.model}</span>
        </Field>
      )}
      {(state.version ?? model.version) && (
        <Field label={t("chat.panel.env.version")}>
          <span className="font-mono text-app-micro">{state.version ?? model.version}</span>
        </Field>
      )}
    </Section>
  );
}

function ContextSection({
  controller,
  state,
}: {
  controller: ChatController;
  state: ChatTabState;
}) {
  const { t } = useTranslation();
  const { model } = state;
  const context = contextOf(model.contextUsage);
  const supported = controller.supports("get_context_usage");
  const running = model.running;
  const percent =
    context && context.maxTokens > 0
      ? Math.min(100, Math.round((context.totalTokens / context.maxTokens) * 100))
      : null;
  return (
    <Section
      title={t("chat.panel.context.title")}
      count={percent !== null ? `${percent}%` : undefined}
    >
      {!supported ? (
        <div className="text-app-micro text-muted-foreground">
          {t("chat.panel.needs_version", { version: firstVersionOf("get_context_usage") })}
        </div>
      ) : !context ? (
        <div className="text-app-micro text-muted-foreground">
          {t("chat.panel.context.unknown")}
        </div>
      ) : (
        <>
          <Meter percent={percent ?? 0} />
          <div className="text-app-micro text-muted-foreground tabular-nums">
            {t("chat.panel.context.tokens", {
              used: formatTokens(context.totalTokens),
              max: formatTokens(context.maxTokens),
            })}
            {context.free !== undefined &&
              ` · ${t("chat.panel.context.free", { count: formatTokens(context.free) })}`}
          </div>
          {context.used.map((category) => (
            <Row key={category.name} className="text-app-micro">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{category.name}</span>
              <span className="tabular-nums">{formatTokens(category.tokens)}</span>
            </Row>
          ))}
        </>
      )}
      <div className="mt-1">
        <button
          type="button"
          onClick={running ? undefined : () => void controller.send("/compact")}
          aria-disabled={running || undefined}
          title={running ? t("chat.panel.context.compact_busy") : undefined}
          className={cn(
            "rounded-(--radius-control) border border-border px-2 py-0.5 text-app-ui-sm",
            running
              ? "cursor-not-allowed opacity-40"
              : "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
          )}
        >
          {t("chat.panel.context.compact")}
        </button>
      </div>
    </Section>
  );
}

function Meter({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full",
          percent >= 90
            ? "bg-[var(--state-error-fg)]"
            : percent >= 70
              ? "bg-[var(--state-warning-fg)]"
              : "bg-[var(--tab-claude-running-fg)]",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function AgentEntry({
  agent,
  now,
  onOpen,
  onStop,
}: {
  agent: AgentRow;
  now: number;
  onOpen: () => void;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const meta = [
    agent.teammate ? t("chat.panel.agents.teammate") : agent.subagentType,
    agent.model,
    t("chat.panel.agents.tools", { count: agent.toolCount }),
  ].filter(Boolean);
  return (
    <div className="flex flex-col">
      <Row>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={agent.description}
        >
          <StatusDot status={agent.status} />
          <span className="min-w-0 flex-1 truncate">{agent.description}</span>
        </button>
        <Elapsed from={agent.startedAt} to={agent.endedAt} now={now} />
        <IconButton label={t("chat.panel.agents.open")} onClick={onOpen}>
          <ExternalLink className="size-3.5" />
        </IconButton>
        {onStop && (
          <IconButton label={t("chat.panel.stop")} onClick={onStop}>
            <Square className="size-3" />
          </IconButton>
        )}
      </Row>
      <div className="truncate pl-4 text-app-micro text-muted-foreground">{meta.join(" · ")}</div>
      {open && (
        <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-border pl-2 text-app-micro">
          {agent.currentTool && agent.status === "running" && (
            <div className="truncate font-mono text-muted-foreground" title={agent.currentTool}>
              {agent.currentTool}
            </div>
          )}
          {agent.lastText ? (
            <div className="line-clamp-4 whitespace-pre-wrap break-words">{agent.lastText}</div>
          ) : (
            <div className="text-muted-foreground">{t("chat.panel.agents.no_text")}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultRow({
  result,
  cwd,
  onOpen,
}: {
  result: ResultEntry;
  cwd: string;
  onOpen: () => void;
}) {
  const Icon =
    result.kind === "url"
      ? Globe
      : IMAGE_EXT.test(result.target)
        ? FileImage
        : result.created
          ? FilePlus
          : FileText;
  const label = result.kind === "file" ? shortPath(result.target, cwd) : result.target;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={result.target}
      className="flex min-h-6 min-w-0 items-center gap-2 rounded-(--radius-control) px-1 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function ChangedRow({ file, cwd, onOpen }: { file: ChangedFile; cwd: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={file.path}
      className="flex min-h-6 min-w-0 items-center gap-2 rounded-(--radius-control) px-1 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
    >
      {file.created ? (
        <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-app-micro">
        {shortPath(file.path, cwd)}
      </span>
      <span className="shrink-0 text-app-micro tabular-nums text-[var(--git-status-added-fg)]">
        +{file.added}
      </span>
      <span className="shrink-0 text-app-micro tabular-nums text-[var(--git-status-deleted-fg)]">
        −{file.removed}
      </span>
    </button>
  );
}

function UsageSection({ controller, state }: { controller: ChatController; state: ChatTabState }) {
  const { t, i18n } = useTranslation();
  const limits = usageLimitsOf(state.model.usage);
  const supported = controller.supports("get_usage");
  return (
    <Section
      title={t("chat.panel.usage.title")}
      folded
      onOpen={() => controller.refreshPanel(["usage"])}
    >
      {!supported ? (
        <div className="text-app-micro text-muted-foreground">
          {t("chat.panel.needs_version", { version: firstVersionOf("get_usage") })}
        </div>
      ) : limits.length === 0 ? (
        <div className="text-app-micro text-muted-foreground">{t("chat.panel.usage.none")}</div>
      ) : (
        limits.map((limit) => (
          <div key={`${limit.kind}-${limit.scope ?? ""}`} className="flex flex-col gap-0.5 py-0.5">
            <Row className="text-app-micro">
              <span className="min-w-0 flex-1 truncate">
                {t(`chat.panel.usage.kind.${limit.kind}`, {
                  defaultValue: limit.kind,
                  scope: limit.scope ?? "",
                })}
              </span>
              <span className="tabular-nums">{Math.round(limit.percent)}%</span>
            </Row>
            <Meter percent={Math.min(100, limit.percent)} />
            {limit.resetsAt && (
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
  );
}

function McpSection({ controller, state }: { controller: ChatController; state: ChatTabState }) {
  const { t } = useTranslation();
  const servers = state.model.mcp;
  const fail = (err: Error) => showToast({ kind: "error", message: err.message });
  return (
    <Section
      title={t("chat.panel.mcp.title")}
      count={servers?.length}
      folded
      onOpen={() => controller.refreshPanel(["mcp"])}
    >
      {!servers || servers.length === 0 ? (
        <div className="text-app-micro text-muted-foreground">{t("chat.panel.mcp.none")}</div>
      ) : (
        servers.map((server) => (
          <Row
            key={server.name}
            title={server.status === "needs-auth" ? t("chat.panel.mcp.auth_hint") : server.name}
          >
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            <span className="shrink-0 text-app-micro text-muted-foreground">
              {t(`chat.panel.mcp.status.${server.status}`, { defaultValue: server.status })}
            </span>
            {server.status !== "disabled" && (
              <IconButton
                label={t("chat.panel.mcp.reconnect")}
                onClick={() => controller.mcpReconnect(server.name).catch(fail)}
              >
                <RefreshCw className="size-3" />
              </IconButton>
            )}
            <Switch
              checked={server.status !== "disabled"}
              onCheckedChange={(enabled) => controller.mcpToggle(server.name, enabled).catch(fail)}
              aria-label={t("chat.panel.mcp.enabled", { name: server.name })}
            />
          </Row>
        ))
      )}
    </Section>
  );
}

function Elapsed({ from, to, now }: { from?: number; to?: number; now: number }) {
  if (from === undefined) return null;
  const seconds = Math.max(0, Math.floor(((to ?? now) - from) / 1000));
  return (
    <span className="shrink-0 text-app-micro text-muted-foreground tabular-nums">
      {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
    </span>
  );
}

/** Tokens as "942", "24.5k" or "1.2M". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function useTicker(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
