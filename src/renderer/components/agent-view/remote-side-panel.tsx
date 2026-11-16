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
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatPanel } from "../../../../packages/remote-protocol/src/view";
import { useNow } from "../../hooks/use-now";
import type { ChatModel } from "../../services/chat/model";
import { type AgentRow, type AgentStatus, agentsOf } from "../../services/chat/panel";
import { formatTokens } from "../../services/chat/usage-line";
import type { RemoteTarget } from "../../state/stores/remote-view";
import { cn } from "../../utils/cn";
import { StatusDot } from "../chat/agent-strip";
import { useChatLinks } from "../chat/chat-links";
import {
  AgentEntry,
  ChangedRow,
  CopyIcon,
  Elapsed,
  Field,
  FirstFew,
  formatCost,
  Meter,
  newestJobsFirst,
  Row,
  Section,
} from "../chat/side-panel";
import { usageMeterLabel } from "../chat/usage-line";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";
import { showToast } from "../ui/toast";
import { peerProfileName } from "./remote-profile-chip";
import { usageLineOf } from "./remote-usage";

/** The panel's parts a bare command shows: /status, /context, /usage. */
export type RemotePanelPart = "status" | "context" | "usage" | "jobs";

/** The part of the panel a bare /status, /context or /usage shows; null for another. */
export function remotePanelPartOf(text: string): RemotePanelPart | null {
  const match = /^\/(status|context|usage)\s*$/i.exec(text.trim());
  return match?.[1] ? (match[1].toLowerCase() as RemotePanelPart) : null;
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
  onCompact: () => void;
  onStopTask: (taskId: string) => void;
  /** Turns its Remote Control on or off there, where it may. */
  onRemoteControl?: (enabled: boolean) => Promise<void>;
  /** Forks its whole session into a new tab there, where it may. */
  onForkSession?: () => void;
  /** The part a bare command asked for, each ask its own seq: it opens and comes into view. */
  reveal?: { part: RemotePanelPart; seq: number } | null;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const links = useChatLinks();
  const agents = useMemo(() => remoteAgentsOf(panel, model), [panel, model]);
  const jobs = panel?.tasks ?? [];
  const todos = panel?.todos ?? [];
  const changed = panel?.changedFiles ?? [];
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
                now={now}
                onStop={controls ? () => onStopTask(job.taskId) : undefined}
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
      {changed.length > 0 && (
        <Section title={t("chat.panel.changed.title")} count={changed.length} folded>
          {changed.map((file) => (
            <ChangedRow
              key={file.path}
              file={{
                path: file.path,
                added: file.added ?? 0,
                removed: file.removed ?? 0,
                created: false,
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

/** A background run, as a chat here lists one: what it is, how long, what it said last. */
function RemoteJob({
  job,
  now,
  onStop,
}: {
  job: ChatPanel["tasks"][number];
  now: number;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const said = job.summary || job.activity;
  return (
    <div className="-mx-1 flex flex-col rounded-(--radius-control) px-1" data-testid="remote-job">
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
        {job.status === "running" && onStop && (
          <IconButton label={t("chat.panel.stop")} onClick={onStop}>
            <Square className="size-3" />
          </IconButton>
        )}
      </Row>
      {open && (
        <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-border pl-2 text-app-micro">
          <div className="truncate font-mono text-muted-foreground">{job.type}</div>
          {said ? <div className="line-clamp-6 whitespace-pre-wrap break-words">{said}</div> : null}
        </div>
      )}
    </div>
  );
}
