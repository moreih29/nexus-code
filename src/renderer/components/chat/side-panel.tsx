// A Claude tab's side panel, its sections always in the same order: where
// it runs, how full its context is, the plan's usage, its goal (while it has
// one), the to-do list Claude keeps, its tasks and its agents (what runs now
// and what ended), and what it made; folded at the end, the files it changed
// and the MCP servers. A section with nothing in it is its title and a 0. What only a request
// tells is asked for when the panel opens and after each turn.

import {
  Check,
  Copy,
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
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { artifactsOf } from "../../services/chat/artifact";
import type { ChatController } from "../../services/chat/controller";
import { useFoundFiles } from "../../services/chat/file-presence";
import { goalViewOf } from "../../services/chat/goal";
import { type JobOutput, readJobOutput } from "../../services/chat/job-output";
import { linkPlaceIndex, linkPlaces } from "../../services/chat/link-places";
import { fileKind, slashWindowsPath } from "../../services/chat/links";
import type { ChatItem, TaskInfo, ToolCall } from "../../services/chat/model";
import {
  type AgentRow,
  type ChangedFile,
  changedFilesOf,
  contextOf,
  distinctResults,
  exitCodeOf,
  jobCommand,
  jobOutputFile,
  jobsOf,
  type ResultEntry,
  resultsOf,
  todosOf,
  usageLimitsOf,
} from "../../services/chat/panel";
import { usePlanUsageStore } from "../../services/chat/plan-usage";
import { type ActivityRow, activityOf, type JobLike } from "../../services/chat/running";
import { type ChatTabState, type RevealPart, takeReveal } from "../../services/chat/store";
import { formatTokens, shownReset } from "../../services/chat/usage-line";
import { firstVersionOf } from "../../services/chat/versions";
import { useGitStore } from "../../state/stores/git";
import { copyText } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import { formatBytes } from "../../utils/format-bytes";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
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

interface SidePanelProps {
  controller: ChatController;
  /**
   * The state beside a streaming reply (beside-stream): its `model.streaming`,
   * `model.turn` and `model.lastSeq` may be behind, and are not read here.
   */
  state: ChatTabState;
  workspaceId: string;
  cwd: string;
  rootPath: string;
  /**
   * The session's subagents, those of its history too, then the `claude -p`
   * runs it started (sessionAgentsOf).
   */
  agents: readonly AgentRow[];
  /** Stops a running run, by its agent id. */
  onStopRun: (agentId: string) => void;
  onShowAgent: (toolUseId: string) => void;
  /** Brings a call into view in the conversation, by its id. */
  onShowCall?: (toolUseId: string) => void;
  /** Sends a call the turn waits on to the background, by its id, as its row's button does. */
  onBackground?: (toolUseId: string) => void;
  /** Opens a new Claude tab from the whole session. */
  onForkSession: () => void;
  className?: string;
}

/** Memoized: a chunk of a streaming reply changes nothing it shows. */
export const SidePanel = memo(function SidePanel({
  controller,
  state,
  workspaceId,
  cwd,
  rootPath,
  agents,
  onStopRun,
  onShowAgent,
  onShowCall,
  onBackground,
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
  const { tasks, permissions, running: turnRunning } = model;
  const jobs = useMemo(() => jobsOf({ tasks }), [tasks]);
  // A call waiting on the user's answer cannot go to the background yet, as in the conversation.
  const waiting = useMemo(
    () => new Set(permissions.flatMap((p) => (p.toolUseId ? [p.toolUseId] : []))),
    [permissions],
  );
  // The calls the turn waits on are the program's, never its history's.
  const activity = useMemo(
    () =>
      activityOf({
        agents,
        jobs,
        tools: model.tools,
        items: model.items,
        waiting,
        turnRunning,
      }),
    [agents, jobs, model.tools, model.items, waiting, turnRunning],
  );
  const todos = useMemo(() => todosOf(tools), [tools]);
  const changed = useMemo(() => changedFilesOf(tools), [tools]);

  const links = useChatLinks();
  // A version without stop_task keeps the button, saying which version has it.
  const stopNote = controller.supports("stop_task")
    ? undefined
    : t("chat.panel.needs_version", { version: firstVersionOf("stop_task") });
  const stopFailed = t("chat.panel.stop_failed");
  const openRow = useCallback(
    (row: ActivityRow) => {
      if (row.agent) onShowAgent(row.agent.toolUseId);
      else if (row.call) onShowCall?.(row.call.id);
    },
    [onShowAgent, onShowCall],
  );
  const stopOf = useCallback(
    (row: ActivityRow): (() => void) | undefined => {
      if (row.status !== "running") return undefined;
      const run = row.agent?.run;
      if (run) return () => onStopRun(run.id);
      const taskId = row.agent?.taskId ?? row.job?.taskId;
      return taskId ? () => stop(controller, taskId, stopFailed) : undefined;
    },
    [controller, onStopRun, stopFailed],
  );
  // The same while the calls change (one streaming in): a job opened reads
  // them as its row draws, and the rows, which may be many, do not draw for it.
  const toolsNow = useRef(tools);
  toolsNow.current = tools;
  const jobDetail = useCallback(
    (job: JobLike) => (
      <JobDetail
        job={job as TaskInfo}
        tools={toolsNow.current}
        workspaceId={workspaceId}
        rootPath={rootPath}
        onShowCall={onShowCall}
        onOpenFile={(path) => links?.openFile(path)}
      />
    ),
    [workspaceId, rootPath, onShowCall, links],
  );
  const onRevealed = useCallback((seq: number) => takeReveal(controller.key, seq), [controller]);
  const jobsAsked = state.reveal?.part === "jobs" ? state.reveal : undefined;

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
      <UsageSection controller={controller} state={state} />
      <GoalSection state={state} />
      <TodosSection todos={todos} />
      <ActivitySections
        activity={activity}
        foldKey={controller.key}
        reveal={jobsAsked}
        onRevealed={onRevealed}
        onOpen={openRow}
        stopOf={stopOf}
        stopNote={stopNote}
        onBackground={onBackground}
        jobDetail={jobDetail}
      />
      <ResultsSection
        items={items}
        tools={tools}
        cwd={cwd}
        workspaceId={workspaceId}
        rootPath={rootPath}
      />
      <Section
        title={t("chat.panel.changed.title")}
        count={changed.length}
        empty={changed.length === 0}
        folded
      >
        {changed.map((file) => (
          <ChangedRow
            key={file.path}
            file={file}
            cwd={cwd}
            onOpen={() => links?.openChange(file.path)}
          />
        ))}
      </Section>
      <McpSection controller={controller} state={state} />
    </aside>
  );
});

/**
 * The to-do list Claude keeps, as a checklist: done, the one it works on,
 * and what waits; counted as done of all.
 */
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
        // A to-do another computer tells has no id: its list is replaced whole.
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

function stop(controller: ChatController, taskId: string, failed: string): void {
  controller.stopTask(taskId).catch((err: Error) => {
    showToast({ kind: "error", message: `${failed}: ${err.message}` });
  });
}

/** A path from the session's folder, when it is under it. */
export function shortPath(path: string, cwd: string): string {
  const base = slashWindowsPath(cwd).replace(/\/$/, "");
  const file = slashWindowsPath(path);
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : path;
}

/**
 * What the chat made, newest first: the pages it published to claude.ai,
 * the files it named once they are found to be files, and the addresses it
 * gave. Another computer's chat finds its files there (ChatFilesContext).
 */
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
  // A file is listed once it is found to be one: from the chat's folder, or
  // from where the agent's shell went (link-places).
  const named = useMemo(() => resultsOf(items, tools, cwd), [items, tools, cwd]);
  const filePlaces = useMemo(() => {
    const index = linkPlaceIndex(tools, cwd);
    const places = new Map<string, string[]>();
    for (const result of named) {
      if (result.kind !== "file") continue;
      const paths = linkPlaces(result.target, index).map((place) => place.path);
      if (paths.length > 0) places.set(result.target, paths);
    }
    return places;
  }, [named, tools, cwd]);
  const lookedUp = useMemo(() => [...new Set([...filePlaces.values()].flat())], [filePlaces]);
  // A file named before the agent made it is found once a tool of its is done.
  const toolsDone = useMemo(
    () =>
      Object.values(tools).filter((t) => t.status !== "running" && t.status !== "streaming").length,
    [tools],
  );
  const found = useFoundFiles(workspaceId, rootPath, lookedUp, toolsDone);
  // Each file's target by the first of its places found.
  const filePaths = useMemo(() => {
    const paths = new Map<string, string>();
    for (const [target, places] of filePlaces) {
      const path = places.find((place) => found.has(place));
      if (path) paths.set(target, path);
    }
    return paths;
  }, [filePlaces, found]);
  const results = useMemo(
    () =>
      distinctResults(
        named.filter((result) => result.kind !== "file" || filePaths.has(result.target)),
        cwd,
        (target) => filePaths.get(target) ?? null,
      ),
    [named, filePaths, cwd],
  );
  // The pages it published to claude.ai, newest first, as what it made; a
  // reply's link to one is that page.
  const artifacts = useMemo(() => artifactsOf(tools, cwd).reverse(), [tools, cwd]);
  const made = useMemo(() => {
    const pages = new Set(artifacts.flatMap((page) => (page.url ? [page.url] : [])));
    // Newest first, as the pages: the first few show.
    return results
      .filter((result) => !(result.kind === "url" && pages.has(result.target)))
      .reverse();
  }, [artifacts, results]);
  const links = useChatLinks();
  const open = (target: string, kind: ResultEntry["kind"]) =>
    kind === "file" ? links?.openFile(target) : links?.openUrl(target);
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

/** The part of the tab a bare command asked to see, when it is this one: its ask's seq. */
function revealSeq(state: ChatTabState, part: RevealPart): number | undefined {
  return state.reveal?.part === part ? state.reveal.seq : undefined;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-2 text-app-ui-sm">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  );
}

export function CopyIcon({ text, label }: { text: string; label: string }) {
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
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
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
  const account = model.init?.account;
  const signedIn = account
    ? [
        account.email,
        account.organization,
        account.subscription,
        account.provider && account.provider !== "firstParty" ? account.provider : undefined,
      ].filter(Boolean)
    : [];
  return (
    <Section
      title={t("chat.panel.env.title")}
      reveal={revealSeq(state, "status")}
      onRevealed={(seq) => takeReveal(controller.key, seq)}
    >
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
      {signedIn.length > 0 && (
        <Field label={t("chat.panel.env.account")}>
          <span className="min-w-0 truncate text-app-micro" title={signedIn.join(" · ")}>
            {signedIn.join(" · ")}
          </span>
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

export function Meter({ percent }: { percent: number }) {
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

/** How often an open job's output is read again while it runs. */
const OUTPUT_POLL_MS = 1000;
/** How many times an output that cannot be read yet is tried: the tab grants it a moment after it names it. */
const OUTPUT_TRIES = 5;

/**
 * The end of a job's output file, read again each second while `live`.
 * Undefined until first read; null when it cannot be read.
 */
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
      // A job at rest is read once it reads.
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

/**
 * The end of a job's output, following its end as it comes unless scrolled
 * up from it; or why there is none to show.
 */
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

function JobDetail({
  job,
  tools,
  workspaceId,
  rootPath,
  onShowCall,
  onOpenFile,
}: {
  job: TaskInfo;
  tools: Record<string, ToolCall>;
  workspaceId: string;
  rootPath: string;
  onShowCall?: (toolUseId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const running = job.status === "running";
  const command = jobCommand(job, tools);
  const outputFile = jobOutputFile(job, tools);
  const output = useJobOutput(workspaceId, rootPath, outputFile, running);
  const exitCode = exitCodeOf(job.summary);
  const toolUseId = job.toolUseId;
  return (
    <div
      className="mt-0.5 mb-1 ml-4 flex flex-col gap-1.5 border-l border-border pl-2 text-app-micro"
      data-testid="chat-job-detail"
    >
      <div className="overflow-hidden rounded-(--radius-control) border border-border">
        {command && (
          <div
            className="code-hl line-clamp-3 border-b border-border bg-[var(--state-hover-bg)] px-2 py-1 font-mono whitespace-pre-wrap break-all"
            title={command}
          >
            <span className="text-[var(--state-success-fg)] select-none">$ </span>
            <Highlighted code={command} language="bash" />
          </div>
        )}
        <JobOutputView output={output} />
      </div>
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
          job.summary && (
            <span className="min-w-0 truncate" title={job.summary}>
              {job.summary}
            </span>
          )
        )}
        {output && output.sizeBytes > 0 && (
          <span className="ml-auto shrink-0 tabular-nums">{formatBytes(output.sizeBytes)}</span>
        )}
      </div>
      {((toolUseId && onShowCall) || outputFile) && (
        <div className="flex flex-wrap gap-1">
          {toolUseId && onShowCall && (
            <JobButton onClick={() => onShowCall(toolUseId)}>
              <MessageSquare className="size-3" />
              {t("chat.panel.jobs.show_call")}
            </JobButton>
          )}
          {outputFile && (
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
      className="flex items-center gap-1 rounded-(--radius-control) border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
    >
      {children}
    </button>
  );
}

function ResultRow({
  result,
  path,
  cwd,
  workspaceId,
  onOpen,
}: {
  result: ResultEntry;
  /** The file it names, where it was found; null for an address. */
  path: string | null;
  cwd: string;
  workspaceId: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
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

export function ChangedRow({
  file,
  cwd,
  onOpen,
}: {
  file: ChangedFile;
  cwd: string;
  /** Opens its change; left out where it cannot be opened here (another computer's file). */
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
        {shortPath(file.path, cwd)}
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

function UsageSection({ controller, state }: { controller: ChatController; state: ChatTabState }) {
  const { t, i18n } = useTranslation();
  // The profile's, one for all its tabs; the tab's own until it has one.
  const plan = usePlanUsageStore((s) => s.byKey[controller.usageKey()]?.claude);
  const limits = usageLimitsOf(plan ?? state.model.usage);
  const supported = controller.supports("get_usage");
  const cost = state.model.costUsd;
  // Open from the start, it asks again as the program comes up: asked before, it is not answered.
  const ready = state.phase === "ready" && state.model.process === "running";
  return (
    <Section
      title={t("chat.panel.usage.title")}
      onOpen={() => controller.refreshPanel(["usage"])}
      openAgain={ready}
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
                  time: shownReset(Date.parse(limit.resetsAt)).toLocaleString(i18n.language, {
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
export function formatCost(usd: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: usd < 1 ? 4 : 2,
  }).format(usd);
}

/** The chat's goal, while it has one, as the bar over the composer tells it. */
function GoalSection({ state }: { state: ChatTabState }) {
  const { t } = useTranslation();
  const { model } = state;
  const goal = goalViewOf(model);
  if (!goal) return null;
  const tab: TabGoal = {
    goal,
    running: model.running,
    ...(model.turn?.startedAt !== undefined ? { startedAt: model.turn.startedAt } : {}),
  };
  return (
    <Section title={t("chat.goal.label")}>
      <GoalSummary tab={tab} />
    </Section>
  );
}

function McpSection({ controller, state }: { controller: ChatController; state: ChatTabState }) {
  const { t } = useTranslation();
  const servers = state.model.mcp;
  const signIn = state.mcpSignIn;
  const ready = state.phase === "ready" && state.model.process === "running";
  const fail = (err: Error) => showToast({ kind: "error", message: err.message });
  // Asked as the program comes up, open or not: with none, it is its title and a 0 and does
  // not open, as a section with nothing; folded, it counts them.
  useEffect(() => {
    if (ready) controller.refreshPanel(["mcp"]);
  }, [ready, controller]);
  return (
    <Section
      title={t("chat.panel.mcp.title")}
      count={servers?.length}
      empty={servers?.length === 0}
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
export function TextButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
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
