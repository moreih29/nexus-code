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
  FilePlus,
  FileText,
  GitFork,
  Globe,
  RefreshCw,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AgentRun } from "../../../shared/claude/activity";
import type { ChatController } from "../../services/chat/controller";
import { useFoundFiles } from "../../services/chat/file-presence";
import { fileKind, resolveFilePath, slashWindowsPath } from "../../services/chat/links";
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
import { type ChatTabState, type RevealPart, takeReveal } from "../../services/chat/store";
import { firstVersionOf } from "../../services/chat/versions";
import { useGitStore } from "../../state/stores/git";
import { copyText } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
import { Switch } from "../ui/switch";
import { showToast } from "../ui/toast";
import { StatusDot } from "./agent-strip";
import { LinkMenu, useChatLinks } from "./chat-links";
import { FileKindIcon } from "./file-kind-icon";

interface SidePanelProps {
  controller: ChatController;
  state: ChatTabState;
  workspaceId: string;
  cwd: string;
  rootPath: string;
  /** The `claude -p` runs the session started, listed after its agents. */
  runs: readonly AgentRow[];
  /** Stops a running run, by its agent id. */
  onStopRun: (agentId: string) => void;
  onShowAgent: (toolUseId: string) => void;
  /** Opens a new Claude tab from the whole session. */
  onForkSession: () => void;
  className?: string;
}

export function SidePanel({
  controller,
  state,
  workspaceId,
  cwd,
  rootPath,
  runs,
  onStopRun,
  onShowAgent,
  onForkSession,
  className,
}: SidePanelProps) {
  const { t } = useTranslation();
  const { model, history } = state;
  const tools = useMemo(
    () => (history ? { ...history.tools, ...model.tools } : model.tools),
    [history, model.tools],
  );
  const items = useMemo(
    () => (history ? [...history.items, ...model.items] : model.items),
    [history, model.items],
  );
  const agents = useMemo(() => [...agentsOf(model), ...runs], [model, runs]);
  const jobs = useMemo(() => jobsOf(model), [model]);
  const todos = useMemo(() => todosOf(tools), [tools]);
  const changed = useMemo(() => changedFilesOf(tools), [tools]);
  // A file only a code span named is listed once the workspace has it.
  const named = useMemo(() => resultsOf(items, tools), [items, tools]);
  const guessed = useMemo(() => {
    const paths = new Map<string, string>();
    for (const result of named) {
      const path = result.guessed ? resolveFilePath(result.target, cwd) : null;
      if (path) paths.set(result.target, path);
    }
    return paths;
  }, [named, cwd]);
  const guessedPaths = useMemo(() => [...new Set(guessed.values())], [guessed]);
  // A file named before the agent made it is found once a tool of its is done.
  const toolsDone = useMemo(
    () =>
      Object.values(tools).filter((t) => t.status !== "running" && t.status !== "streaming").length,
    [tools],
  );
  const found = useFoundFiles(workspaceId, rootPath, guessedPaths, toolsDone);
  const results = useMemo(
    () =>
      named.filter((result) => {
        if (!result.guessed) return true;
        const path = guessed.get(result.target);
        return path !== undefined && found.has(path);
      }),
    [named, guessed, found],
  );
  const anyRunning =
    agents.some((a) => a.status === "running") || jobs.some((j) => j.status === "running");
  const now = useTicker(anyRunning);

  const links = useChatLinks();
  const open = (target: string, kind: ResultEntry["kind"]) =>
    kind === "file" ? links?.openFile(target) : links?.openUrl(target);
  // A version without stop_task keeps the button, saying which version has it.
  const stopNote = controller.supports("stop_task")
    ? undefined
    : t("chat.panel.needs_version", { version: firstVersionOf("stop_task") });

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
                agent.status !== "running"
                  ? undefined
                  : agent.run
                    ? () => onStopRun((agent.run as AgentRun).id)
                    : agent.taskId
                      ? () => stop(controller, agent.taskId as string, t("chat.panel.stop_failed"))
                      : undefined
              }
              stopNote={agent.run ? undefined : stopNote}
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
                  label={stopNote ?? t("chat.panel.stop")}
                  disabled={stopNote !== undefined}
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
              workspaceId={workspaceId}
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
              onOpen={() => links?.openChange(file.path)}
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

/** A path from the session's folder, when it is under it. */
function shortPath(path: string, cwd: string): string {
  const base = slashWindowsPath(cwd).replace(/\/$/, "");
  const file = slashWindowsPath(path);
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : path;
}

/** How long a section a bare command opened keeps itself at the top as it fills. */
const REVEAL_FOLLOW_MS = 1500;

/**
 * Scrolls the panel so a section starts at its top, moving only the panel:
 * scrollIntoView would move every box around it that can scroll.
 */
function scrollToTop(el: HTMLElement): void {
  for (let box = el.parentElement; box; box = box.parentElement) {
    const { overflowY } = getComputedStyle(box);
    if (overflowY === "auto" || overflowY === "scroll") {
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      return;
    }
  }
}

/** The part of the tab a bare command asked to see, when it is this one: its ask's seq. */
function revealSeq(state: ChatTabState, part: RevealPart): number | undefined {
  return state.reveal?.part === part ? state.reveal.seq : undefined;
}

function Section({
  title,
  count,
  folded = false,
  onOpen,
  openAgain,
  reveal,
  onRevealed,
  children,
}: {
  title: string;
  count?: number | string;
  /** Starts folded. */
  folded?: boolean;
  /** Called each time the section opens. */
  onOpen?: () => void;
  /** Called again, while open, when this changes: as the program comes up. */
  openAgain?: unknown;
  /** Set when a bare command asked for this section: it opens and comes into view. */
  reveal?: number;
  onRevealed?: (seq: number) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!folded);
  const ref = useRef<HTMLElement>(null);
  // The ask to scroll to, once the section has opened: before, the panel
  // may be too short to bring it to the top.
  const [scrollFor, setScrollFor] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked for each time it opens, not when the callback changes
  useEffect(() => {
    if (open) onOpen?.();
  }, [open, openAgain]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, not when the callback changes
  useEffect(() => {
    if (reveal === undefined) return;
    setOpen(true);
    setScrollFor(reveal);
    onRevealed?.(reveal);
  }, [reveal]);
  useEffect(() => {
    const el = ref.current;
    if (scrollFor === null || !el) return;
    scrollToTop(el);
    // What it shows may come a moment later (the MCP servers, the usage),
    // and only then can the panel scroll far enough: it follows for a while.
    const observer = new ResizeObserver(() => scrollToTop(el));
    observer.observe(el);
    const timer = setTimeout(() => observer.disconnect(), REVEAL_FOLLOW_MS);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [scrollFor]);
  return (
    <section ref={ref} className="border-b border-border px-3 py-2">
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
      reveal={revealSeq(state, "context")}
      onRevealed={(seq) => takeReveal(controller.key, seq)}
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
  stopNote,
}: {
  agent: AgentRow;
  now: number;
  onOpen: () => void;
  onStop?: () => void;
  /** Why stopping is not possible, as on a version without it. */
  stopNote?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const meta = [
    agent.teammate ? t("chat.panel.agents.teammate") : agent.subagentType,
    agent.model,
    agent.endpoint,
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
        <IconButton
          label={agent.run ? t("chat.panel.agents.open_run") : t("chat.panel.agents.open")}
          onClick={onOpen}
        >
          <ExternalLink className="size-3.5" />
        </IconButton>
        {onStop && (
          <IconButton
            label={stopNote ?? t("chat.panel.stop")}
            disabled={stopNote !== undefined}
            onClick={onStop}
          >
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
  workspaceId,
  onOpen,
}: {
  result: ResultEntry;
  cwd: string;
  workspaceId: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const path = result.kind === "file" ? resolveFilePath(result.target, cwd) : null;
  const label = result.kind === "file" ? shortPath(result.target, cwd) : result.target;
  // An image shows itself while the pointer is on its row.
  const [hover, setHover] = useState<DOMRect | null>(null);
  const image = path !== null && fileKind(path) === "image";
  return (
    <>
      <LinkMenu target={path ?? result.target} href={result.target} kind={result.kind}>
        <button
          type="button"
          onClick={onOpen}
          onMouseEnter={
            image ? (event) => setHover(event.currentTarget.getBoundingClientRect()) : undefined
          }
          onMouseLeave={image ? () => setHover(null) : undefined}
          title={result.target}
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

/** Largest side of an image's hover thumbnail, in pixels. */
const THUMB_PX = 192;

/** An image beside the panel, by the row the pointer is on. */
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
  // The viewers read only the workspace's files so far.
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
  const cost = state.model.costUsd;
  return (
    <Section
      title={t("chat.panel.usage.title")}
      folded
      onOpen={() => controller.refreshPanel(["usage"])}
      reveal={revealSeq(state, "usage")}
      onRevealed={(seq) => takeReveal(controller.key, seq)}
    >
      {cost !== undefined && cost > 0 && (
        <Row className="text-app-micro" title={t("chat.panel.usage.cost_hint")}>
          <span className="min-w-0 flex-1 truncate">{t("chat.panel.usage.cost")}</span>
          <span className="tabular-nums" data-testid="chat-panel-cost">
            {formatCost(cost, i18n.language)}
          </span>
        </Row>
      )}
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

/** Dollars, with the cents' fractions a small session's cost is in. */
function formatCost(usd: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: usd < 1 ? 4 : 2,
  }).format(usd);
}

function McpSection({ controller, state }: { controller: ChatController; state: ChatTabState }) {
  const { t } = useTranslation();
  const servers = state.model.mcp;
  const signIn = state.mcpSignIn;
  const ready = state.phase === "ready" && state.model.process === "running";
  const fail = (err: Error) => showToast({ kind: "error", message: err.message });
  return (
    <Section
      title={t("chat.panel.mcp.title")}
      count={servers?.length}
      folded
      onOpen={() => controller.refreshPanel(["mcp"])}
      openAgain={ready}
      reveal={revealSeq(state, "mcp")}
      onRevealed={(seq) => takeReveal(controller.key, seq)}
    >
      {!servers || servers.length === 0 ? (
        <div className="text-app-micro text-muted-foreground">{t("chat.panel.mcp.none")}</div>
      ) : (
        servers.map((server) => {
          const signingIn = signIn?.serverName === server.name;
          return (
            <Row
              key={server.name}
              title={signingIn ? t("chat.panel.mcp.signing_in_hint") : server.name}
            >
              <span className="min-w-0 flex-1 truncate">{server.name}</span>
              {signingIn ? (
                <span className="flex shrink-0 items-center gap-1 text-app-micro text-muted-foreground">
                  {t("chat.panel.mcp.signing_in")}
                  <TextButton onClick={() => controller.reopenMcpSignIn()}>
                    {t("chat.panel.mcp.reopen")}
                  </TextButton>
                  <TextButton onClick={() => controller.cancelMcpSignIn()}>
                    {t("chat.panel.mcp.cancel")}
                  </TextButton>
                </span>
              ) : server.status === "needs-auth" ? (
                <TextButton onClick={() => controller.mcpAuthenticate(server.name).catch(fail)}>
                  {t("chat.panel.mcp.sign_in")}
                </TextButton>
              ) : (
                <span className="shrink-0 text-app-micro text-muted-foreground">
                  {t(`chat.panel.mcp.status.${server.status}`, { defaultValue: server.status })}
                </span>
              )}
              {server.status !== "disabled" && !signingIn && (
                <IconButton
                  label={t("chat.panel.mcp.reconnect")}
                  onClick={() => controller.mcpReconnect(server.name).catch(fail)}
                >
                  <RefreshCw className="size-3" />
                </IconButton>
              )}
              <Switch
                checked={server.status !== "disabled"}
                onCheckedChange={(enabled) =>
                  controller.mcpToggle(server.name, enabled).catch(fail)
                }
                aria-label={t("chat.panel.mcp.enabled", { name: server.name })}
              />
            </Row>
          );
        })
      )}
    </Section>
  );
}

/** A small button in a row's words: signing in to a server, opening its page again. */
function TextButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-(--radius-control) px-1 text-app-micro text-primary hover:bg-[var(--state-hover-bg)]"
    >
      {children}
    </button>
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
