/**
 * Another computer's chat's side panel, as a chat here has it and with its
 * parts: what it runs on and with, its context, its subagents and
 * background runs, its to-dos, the files it changed and the plan's usage.
 * They come from the panel its computer tells (chat.watch's `panel`), the
 * subagents' details from the conversation shown. A changed file opens its
 * change, read from that computer. Its MCP servers are shown as they stand
 * there; signing in to one, turning it off or on is that computer's to do.
 */

import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  ExternalLink,
  GitFork,
  MessageSquare,
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
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
import { formatTokens } from "../../services/chat/usage-line";
import { peerWorkspaceId } from "../../services/remote/peer-workspace";
import type { RemoteTarget } from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { StatusDot } from "../chat/agent-strip";
import { useChatLinks } from "../chat/chat-links";
import { Highlighted } from "../chat/code-highlight";
import {
  AgentEntry,
  ChangedRow,
  CopyIcon,
  Elapsed,
  Field,
  FirstFew,
  formatCost,
  JobButton,
  Meter,
  newestJobsFirst,
  ResultsSection,
  Row,
  Section,
  useRevealedRow,
} from "../chat/side-panel";
import { usageMeterLabel } from "../chat/usage-line";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";
import { showToast } from "../ui/toast";
import { peerProfileName } from "./remote-profile-chip";
import { usageLineOf } from "./remote-usage";

/** The panel's parts a bare command shows: /status, /context, /usage; /diff its changed files. */
export type RemotePanelPart = "status" | "context" | "usage" | "jobs" | "changes";

/** A part of the panel asked for, each ask its own seq; `id`: the task of the job meant. */
export interface RemotePanelAsk {
  part: RemotePanelPart;
  seq: number;
  id?: string;
}

/**
 * The part of the panel a bare /status, /context or /usage shows; null for
 * another. A Codex chat has /status only, as its tab here does.
 */
export function remotePanelPartOf(
  text: string,
  agent: "claude" | "codex" = "claude",
): RemotePanelPart | null {
  const match = /^\/(status|context|usage)\s*$/i.exec(text.trim());
  const part = match?.[1]?.toLowerCase() as RemotePanelPart | undefined;
  if (!part || (agent === "codex" && part !== "status")) return null;
  return part;
}

const AGENT_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed", "stopped"]);

/**
 * The chat's subagents: the computer's list, each with what the conversation
 * shown tells of it (its tools, its last words, its task), and those the
 * conversation names that the list does not have yet.
 */
export function remoteAgentsOf(panel: ChatPanel | undefined, model: ChatModel): AgentRow[] {
  const known = new Map(agentsOf(model).map((row) => [row.toolUseId, row]));
  const rows: AgentRow[] = [];
  for (const agent of panel?.agents ?? []) {
    const seen = known.get(agent.toolUseId);
    known.delete(agent.toolUseId);
    const status = (AGENT_STATUSES.has(agent.status) ? agent.status : "stopped") as AgentStatus;
    rows.push({
      ...(seen ?? { toolCount: 0, teammate: false }),
      toolUseId: agent.toolUseId,
      description: agent.description || seen?.description || "",
      status,
      ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
      ...(agent.endedAt !== undefined ? { endedAt: agent.endedAt } : {}),
    });
  }
  return [...rows, ...known.values()];
}

export function RemoteSidePanel({
  target,
  panel,
  model,
  controls,
  onShowAgent,
  onShowCall,
  onCompact,
  onStopTask,
  onRemoteControl,
  onForkSession,
  reveal,
  className,
}: {
  target: RemoteTarget;
  /** What the computer tells of the chat's panel; none before it said. */
  panel: ChatPanel | undefined;
  model: ChatModel;
  /** The computer lets this one control its chats: stop a run, compact. */
  controls: boolean;
  onShowAgent: (toolUseId: string) => void;
  /** Brings a call into view in the conversation, as a job's "show the call" asks. */
  onShowCall?: (toolUseId: string) => void;
  onCompact: () => void;
  onStopTask: (taskId: string) => void;
  /** Turns its Remote Control on or off there, where it may. */
  onRemoteControl?: (enabled: boolean) => Promise<void>;
  /** Forks its whole session into a new tab there, where it may. */
  onForkSession?: () => void;
  /**
   * The part a bare command asked for, each ask its own seq: it opens and
   * comes into view; with `id`, the job of that task the conversation named.
   */
  reveal?: RemotePanelAsk | null;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const links = useChatLinks();
  const agents = useMemo(() => remoteAgentsOf(panel, model), [panel, model]);
  const jobs = panel?.tasks ?? [];
  const todos = panel?.todos ?? [];
  const changed = panel?.changedFiles ?? [];
  // A computer before 0.13.0 tells no file it made: the calls read here may.
  const madeHere = useMemo(
    () => new Set(changedFilesOf(model.tools).flatMap((f) => (f.created ? [f.path] : []))),
    [model.tools],
  );
  const anyRunning =
    agents.some((a) => a.status === "running") || jobs.some((j) => j.status === "running");
  const now = useNow(anyRunning);
  const context = panel?.context ?? null;
  const percent =
    context && context.maxTokens > 0
      ? Math.min(100, Math.round((context.usedTokens / context.maxTokens) * 100))
      : null;
  const usage = usageLineOf(panel);
  const limits = usage ? [...usage.meters, ...usage.more] : [];
  const cost = panel?.costUsd;
  // The task a subagent runs as, which stops it.
  const taskOf = (toolUseId: string) =>
    Object.values(model.tasks).find((task) => task.toolUseId === toolUseId)?.taskId;
  const asked = (part: RemotePanelPart) => (reveal?.part === part ? reveal.seq : undefined);
  const session = panel?.session;
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
      data-testid="remote-side-panel"
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
          <span className="min-w-0 truncate text-app-micro" title={target.deviceName}>
            {target.deviceName}
          </span>
        </Field>
        <Field label={t("chat.panel.env.folder")}>
          <span
            className="min-w-0 truncate font-mono text-app-micro"
            title={target.cwd ?? target.path}
          >
            {target.cwd ?? target.path}
          </span>
        </Field>
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
        {session?.version && (
          <Field label={t("chat.panel.env.version")}>
            <span className="font-mono text-app-micro">{session.version}</span>
          </Field>
        )}
        {session?.account && (
          <Field label={t("chat.panel.env.account")}>
            <span className="min-w-0 truncate text-app-micro" title={session.account}>
              {session.account}
            </span>
          </Field>
        )}
        {target.profile && (
          <Field label={t("chat.panel.env.profile")}>
            <span className="min-w-0 truncate text-app-micro">
              {peerProfileName(target.profile, t)}
            </span>
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
            {t("chat.panel.context.unknown")}
          </div>
        ) : (
          <>
            <Meter percent={percent ?? 0} />
            <div className="text-app-micro text-muted-foreground tabular-nums">
              {t("chat.panel.context.tokens", {
                used: formatTokens(context.usedTokens),
                max: formatTokens(context.maxTokens),
              })}
            </div>
          </>
        )}
        {controls && (
          <div className="mt-1">
            <button
              type="button"
              onClick={model.running ? undefined : onCompact}
              aria-disabled={model.running || undefined}
              title={model.running ? t("chat.panel.context.compact_busy") : undefined}
              className={cn(
                "rounded-(--radius-control) border border-border px-2 py-0.5 text-app-ui-sm",
                model.running
                  ? "cursor-not-allowed opacity-40"
                  : "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
              )}
            >
              {t("chat.panel.context.compact")}
            </button>
          </div>
        )}
      </Section>
      {agents.length > 0 && (
        <Section title={t("chat.panel.agents.title")} count={agents.length}>
          {agents.map((agent) => {
            const taskId = agent.taskId ?? taskOf(agent.toolUseId);
            return (
              <AgentEntry
                key={agent.toolUseId}
                agent={agent}
                now={now}
                onOpen={() => onShowAgent(agent.toolUseId)}
                onStop={
                  controls && agent.status === "running" && taskId
                    ? () => onStopTask(taskId)
                    : undefined
                }
              />
            );
          })}
        </Section>
      )}
      {jobs.length > 0 && (
        <Section title={t("chat.panel.jobs.title")} count={jobs.length} reveal={asked("jobs")}>
          <FirstFew>
            {newestJobsFirst(jobs).map((job) => (
              <RemoteJob
                key={job.taskId}
                job={job}
                tools={model.tools}
                now={now}
                reveal={
                  reveal?.part === "jobs" && reveal.id === job.taskId ? reveal.seq : undefined
                }
                onStop={controls ? () => onStopTask(job.taskId) : undefined}
                {...(onShowCall ? { onShowCall } : {})}
              />
            ))}
          </FirstFew>
        </Section>
      )}
      {todos.length > 0 && (
        <Section
          title={t("chat.panel.todos.title")}
          count={`${todos.filter((todo) => todo.status === "completed").length}/${todos.length}`}
        >
          {todos.map((todo, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a to-do has no id of its own, and the list is replaced whole
            <Row key={i}>
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
      <ResultsSection
        items={model.items}
        tools={model.tools}
        cwd={target.cwd ?? target.path}
        workspaceId={peerWorkspaceId(target.deviceId, target.workspaceId)}
        rootPath={target.path}
      />
      {changed.length > 0 && (
        <Section
          title={t("chat.panel.changed.title")}
          count={changed.length}
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
              cwd={target.cwd ?? target.path}
              {...(links ? { onOpen: () => links.openChange(file.path) } : {})}
            />
          ))}
        </Section>
      )}
      <Section title={t("chat.panel.usage.title")} folded reveal={asked("usage")}>
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
      {panel?.mcp && <RemoteMcp servers={panel.mcp} />}
    </aside>
  );
}

/** Its MCP servers as they stand there, as a chat here lists its own. */
function RemoteMcp({ servers }: { servers: NonNullable<ChatPanel["mcp"]> }) {
  const { t } = useTranslation();
  return (
    <Section title={t("chat.panel.mcp.title")} count={servers.length} folded>
      {servers.length === 0 ? (
        <div className="text-app-micro text-muted-foreground">{t("chat.panel.mcp.none")}</div>
      ) : (
        servers.map((server) => (
          <Row key={server.name} title={server.name}>
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            <span className="shrink-0 text-app-micro text-muted-foreground">
              {t(`chat.panel.mcp.status.${server.status}`, { defaultValue: server.status })}
            </span>
          </Row>
        ))
      )}
    </Section>
  );
}

/**
 * A background run, as a chat here lists one: what it is, how long; opened,
 * the command it runs, what it said last, how it ended, and its call. Its
 * output is in a file on that computer, which this one does not read.
 */
function RemoteJob({
  job,
  tools,
  now,
  reveal,
  onStop,
  onShowCall,
}: {
  job: ChatPanel["tasks"][number];
  tools: Record<string, ToolCall>;
  now: number;
  /** Set when the conversation asked for this job: it opens and comes into view. */
  reveal?: number | undefined;
  onStop?: (() => void) | undefined;
  onShowCall?: (toolUseId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { ref, lit } = useRevealedRow(reveal, () => setOpen(true));
  const running = job.status === "running";
  const command = jobCommand(job, tools);
  const said = running ? job.activity || job.summary : job.summary || job.activity;
  const exitCode = exitCodeOf(job.summary);
  const toolUseId = job.toolUseId;
  return (
    <div
      ref={ref}
      className={cn(
        "-mx-1 flex flex-col rounded-(--radius-control) px-1 transition-colors duration-500",
        lit && "bg-[var(--state-hover-bg)]",
      )}
      data-testid="remote-job"
    >
      <Row>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={job.summary || job.description}
        >
          <StatusDot status={job.status} />
          <span className="min-w-0 flex-1 truncate">{job.description || job.taskId}</span>
          <Elapsed from={job.startedAt} to={job.endedAt} now={now} />
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
        </button>
        {running && onStop && (
          <IconButton label={t("chat.panel.stop")} onClick={onStop}>
            <Square className="size-3" />
          </IconButton>
        )}
      </Row>
      {open && (
        <div
          className="mt-0.5 mb-1 ml-4 flex flex-col gap-1.5 border-l border-border pl-2 text-app-micro"
          data-testid="remote-job-detail"
        >
          {(command || said) && (
            <div className="overflow-hidden rounded-(--radius-control) border border-border">
              {command && (
                <div
                  className={cn(
                    "code-hl line-clamp-3 bg-[var(--state-hover-bg)] px-2 py-1 font-mono whitespace-pre-wrap break-all",
                    said && "border-b border-border",
                  )}
                  title={command}
                >
                  <span className="text-[var(--state-success-fg)] select-none">$ </span>
                  <Highlighted code={command} language="bash" />
                </div>
              )}
              {said && (
                <div className="line-clamp-6 px-2 py-1.5 whitespace-pre-wrap break-words">
                  {said}
                </div>
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
            ) : (
              <span className="truncate font-mono">{job.type}</span>
            )}
          </div>
          {toolUseId && onShowCall && (
            <div className="flex flex-wrap gap-1">
              <JobButton onClick={() => onShowCall(toolUseId)}>
                <MessageSquare className="size-3" />
                {t("chat.panel.jobs.show_call")}
              </JobButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
