// The side panel's Tasks and Agents sections: what the session runs, its
// commands in one (background jobs, and the commands its turn waits on,
// once they have run a moment), its subagents and `claude -p` runs in the
// other. Each has two folds: what runs now, open while something does (a
// call the turn waits on can go to the background from there), and what
// ended, which opens to a list to search. The folds stay as they were left.
// A chat here and another computer's chat both show them.

import type { TFunction } from "i18next";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleStop,
  CircleX,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
  Play,
  Square,
  SquareTerminal,
} from "lucide-react";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNow } from "../../hooks/use-now";
import type { AgentStatus } from "../../services/chat/panel";
import {
  type Activity,
  type ActivityKind,
  type ActivityRow,
  activityParts,
  endedAtOf,
  heldBack,
  type JobLike,
  sameEndedRows,
  searchActivity,
} from "../../services/chat/running";
import { cn } from "../../utils/cn";
import { elapsedLabel } from "../agent-list/agent-status";
import { IconButton } from "../ui/icon-button";
import { SearchInput } from "../ui/search-input";
import { relativeTime } from "./message-list";
import { FirstFew, Row, Section, useFold, useRevealedRow } from "./panel-section";
import { BackgroundBadge, BackgroundIcon } from "./tool-row";

/** How many ended rows show before the rest is asked for. */
export const ENDED_FIRST = 5;

/** A bare /tasks (no `id`), or the job of a task the conversation named; each ask its own seq. */
export interface RunningReveal {
  seq: number;
  id?: string;
}

export interface ActivitySectionsProps {
  activity: Activity;
  /** Whose folds these are: the tab's key, kept apart from another tab's. */
  foldKey: string;
  /** A job asked for: the Tasks section's. */
  reveal?: RunningReveal;
  /** The ask was answered: shown. */
  onRevealed?: (seq: number) => void;
  /** Shows a row's subagent or run in the pane, or a call in the conversation. */
  onOpen: (row: ActivityRow) => void;
  /** What stops a running row, where it can be stopped from here. */
  stopOf: (row: ActivityRow) => (() => void) | undefined;
  /** Why a subagent or a job cannot be stopped, as on a version without it. */
  stopNote?: string;
  /** Sends a call the turn waits on to the background, by its id; absent where it cannot. */
  onBackground?: (toolUseId: string) => void;
  /** A job opened: its command and output. */
  jobDetail: (job: JobLike) => React.ReactNode;
}

/** The Tasks section, then the Agents section, always both, in their places. */
export function ActivitySections({ activity, reveal, ...rest }: ActivitySectionsProps) {
  const { t } = useTranslation();
  const running = useShownRunning(activity.running);
  const parts = useMemo(
    () => activityParts({ running, ended: activity.ended }),
    [running, activity.ended],
  );
  return (
    <>
      <ActivitySection
        part="commands"
        title={t("chat.panel.jobs.title")}
        activity={parts.commands}
        reveal={reveal}
        {...rest}
      />
      <ActivitySection
        part="agents"
        title={t("chat.panel.agents.title")}
        activity={parts.agents}
        {...rest}
      />
    </>
  );
}

/**
 * The running rows to list now: a command the turn waits on only once it
 * has run WAITED_CALL_DELAY_MS, drawn again when the first held back is due.
 */
function useShownRunning(rows: ActivityRow[]): ActivityRow[] {
  // When each waited command was first seen, for one whose message tells no time.
  const seen = useRef(new Map<string, number>());
  // Counts the times one fell due: a timer that fires a moment early is set again.
  const [dues, setDues] = useState(0);
  const now = Date.now();
  const firstSeen = seen.current;
  for (const row of rows) if (row.call && !firstSeen.has(row.key)) firstSeen.set(row.key, now);
  if (firstSeen.size > 0) {
    const keys = new Set(rows.map((row) => row.key));
    for (const key of firstSeen.keys()) if (!keys.has(key)) firstSeen.delete(key);
  }
  const { shown, nextAt } = heldBack(rows, now, firstSeen);
  // biome-ignore lint/correctness/useExhaustiveDependencies: set again each time one falls due
  useEffect(() => {
    if (nextAt === undefined) return;
    const timer = setTimeout(() => setDues((n) => n + 1), Math.max(0, nextAt - Date.now()));
    return () => clearTimeout(timer);
  }, [nextAt, dues]);
  return shown;
}

/**
 * One of the two sections: what runs, then what ended, each a fold under
 * the title that counts it. Memoized: it renders when what it lists changes,
 * not for each change of the chat.
 */
const ActivitySection = memo(function ActivitySection({
  part,
  title,
  activity,
  foldKey,
  reveal,
  onRevealed,
  onOpen,
  stopOf,
  stopNote,
  onBackground,
  jobDetail,
}: Omit<ActivitySectionsProps, "activity"> & {
  part: "commands" | "agents";
  title: string;
  activity: Activity;
}) {
  const { t } = useTranslation();
  const { running } = activity;
  // Kept while it shows the same, so the list, which may be long, is not drawn again.
  const kept = useRef(activity.ended);
  if (!sameEndedRows(kept.current, activity.ended)) kept.current = activity.ended;
  const ended = kept.current;
  // The job asked for, and where it is.
  const asked = reveal?.id;
  const runningAsked = asked !== undefined && running.some((row) => row.job?.taskId === asked);
  const endedAsked = asked !== undefined && ended.some((row) => row.job?.taskId === asked);
  // A bare ask, or one for a job no longer listed, shows the section; with
  // nothing running, what ended.
  const bare = reveal !== undefined && !runningAsked && !endedAsked;
  const [runningOpen, setRunningOpen] = useFold(`${foldKey}:${part}:running`, true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once
  useEffect(() => {
    if (runningAsked) setRunningOpen(true);
  }, [reveal?.seq]);
  return (
    <Section
      title={title}
      reveal={bare ? reveal?.seq : undefined}
      onRevealed={onRevealed}
      opened={runningAsked || endedAsked ? reveal?.seq : undefined}
    >
      <div className="flex flex-col" data-testid={`panel-${part}`}>
        <Fold
          label={t("chat.panel.running.title")}
          count={running.length}
          live
          open={runningOpen || runningAsked}
          onToggle={() => setRunningOpen(!runningOpen)}
          testId="panel-running"
        >
          {running.map((row) => (
            <RunningRow
              key={row.key}
              row={row}
              reveal={runningAsked && row.job?.taskId === asked ? reveal?.seq : undefined}
              onRevealed={onRevealed}
              onOpen={onOpen}
              stopOf={stopOf}
              stopNote={row.kind === "run" ? undefined : stopNote}
              onBackground={onBackground}
              jobDetail={jobDetail}
            />
          ))}
        </Fold>
        <EndedFold
          rows={ended}
          foldKey={`${foldKey}:${part}:ended`}
          opened={endedAsked || (bare && running.length === 0) ? reveal?.seq : undefined}
          reveal={endedAsked ? reveal : undefined}
          onRevealed={onRevealed}
          onOpen={onOpen}
          jobDetail={jobDetail}
        />
      </div>
    </Section>
  );
});

/**
 * A fold under a section's title, its rows set in under it: its label and
 * how many it holds; with none, only that, and it does not open.
 */
function Fold({
  label,
  count,
  live = false,
  open,
  onToggle,
  testId,
  children,
}: {
  label: string;
  count: number;
  /** Counts what runs now: its count in the color of a link while it does. */
  live?: boolean;
  open: boolean;
  onToggle: () => void;
  testId: string;
  children?: React.ReactNode;
}) {
  const empty = count === 0;
  const shown = open && !empty;
  return (
    <div className="flex flex-col" data-testid={testId}>
      <button
        type="button"
        onClick={empty ? undefined : onToggle}
        aria-expanded={empty ? undefined : shown}
        aria-disabled={empty || undefined}
        className={cn(
          "flex min-h-6 w-full items-center gap-1 pl-3 text-left text-app-ui-sm",
          empty ? "cursor-default text-muted-foreground" : "hover:text-foreground",
        )}
      >
        {shown ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight
            className={cn("size-3 shrink-0 text-muted-foreground", empty && "opacity-40")}
          />
        )}
        <span>{label}</span>
        <span
          className={cn(
            "tabular-nums",
            live && !empty ? "font-semibold text-[var(--state-info-fg)]" : "text-muted-foreground",
          )}
          data-testid={`${testId}-count`}
        >
          {count}
        </span>
      </button>
      {shown && (
        <div className="mb-1 ml-4 flex flex-col gap-0.5 border-l border-border pl-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

/** A row's state as a small glyph: spinning while it runs. */
export function ActivityGlyph({ status }: { status: AgentStatus }) {
  const { t } = useTranslation();
  const label = t(`chat.panel.status.${status}`);
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "running":
      return (
        <LoaderCircle
          role="img"
          aria-label={label}
          className={cn(cls, "animate-spin text-[var(--state-loading-indicator)]")}
        />
      );
    case "completed":
      return (
        <CircleCheck
          role="img"
          aria-label={label}
          className={cn(cls, "text-[var(--state-success-fg)]")}
        />
      );
    case "failed":
      return (
        <CircleX
          role="img"
          aria-label={label}
          className={cn(cls, "text-[var(--state-error-fg)]")}
        />
      );
    default:
      return (
        <CircleStop role="img" aria-label={label} className={cn(cls, "text-muted-foreground")} />
      );
  }
}

const KIND_ICONS: Record<ActivityKind, typeof Bot> = {
  agent: Bot,
  command: SquareTerminal,
  run: Play,
};

/** What a row is, as an icon titled with its kind. */
function KindIcon({ kind }: { kind: ActivityKind }) {
  const { t } = useTranslation();
  const Icon = KIND_ICONS[kind];
  const label = t(`chat.panel.running.kind.${kind}`);
  return (
    <span title={label} className="flex shrink-0">
      <Icon role="img" aria-label={label} className="size-3.5 text-muted-foreground" />
    </span>
  );
}

/** How long a row has run, ticking while it runs. */
function RunningFor({ from }: { from?: number }) {
  const now = useNow(from !== undefined);
  if (from === undefined) return null;
  return (
    <span className="shrink-0 text-app-micro text-muted-foreground tabular-nums">
      {elapsedLabel(Math.max(0, now - from))}
    </span>
  );
}

/** A row's second line: its subagent's kind, model and calls; a command's kind. */
function metaOf(row: ActivityRow, t: TFunction): string {
  const agent = row.agent;
  if (agent) {
    return [
      agent.teammate ? t("chat.panel.agents.teammate") : agent.subagentType,
      agent.model,
      agent.endpoint,
      t("chat.panel.agents.tools", { count: agent.toolCount }),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const type = row.job?.type;
  return type && type !== "local_bash" ? type : t("chat.panel.running.kind.command");
}

const RunningRow = memo(function RunningRow({
  row,
  reveal,
  onRevealed,
  onOpen,
  stopOf,
  stopNote,
  onBackground,
  jobDetail,
}: {
  row: ActivityRow;
  reveal?: number;
  onRevealed?: (seq: number) => void;
  onOpen: (row: ActivityRow) => void;
  stopOf: (row: ActivityRow) => (() => void) | undefined;
  stopNote?: string;
  onBackground?: (toolUseId: string) => void;
  jobDetail: (job: JobLike) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { ref, lit } = useRevealedRow(reveal, () => setOpen(true), onRevealed);
  const agent = row.agent;
  const job = row.job;
  // A command waited on with no job yet has nothing to open here: its call is in the conversation.
  const opens = agent !== undefined || job !== undefined;
  const foreground = row.foreground;
  const onStop = stopOf(row);
  return (
    <div
      ref={ref}
      className={cn(
        "-mx-1 flex flex-col rounded-(--radius-control) px-1 transition-colors duration-500",
        lit && "bg-[var(--state-hover-bg)]",
      )}
      data-testid="running-row"
      data-kind={row.kind}
    >
      <Row>
        <button
          type="button"
          onClick={opens ? () => setOpen((v) => !v) : () => onOpen(row)}
          aria-expanded={opens ? open : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={job?.summary || row.description}
        >
          <ActivityGlyph status={row.status} />
          <span className="min-w-0 flex-1 truncate">{row.description}</span>
        </button>
        {row.background && <BackgroundBadge testId="running-background" />}
        <RunningFor from={row.startedAt} />
        {foreground && onBackground && (
          <IconButton
            label={t("chat.panel.running.to_background")}
            onClick={() => onBackground(foreground)}
            data-testid="running-to-background"
          >
            <BackgroundIcon className="size-3.5" />
          </IconButton>
        )}
        <OpenButton row={row} open={open} onToggle={() => setOpen((v) => !v)} onOpen={onOpen} />
        {onStop && (
          <IconButton
            label={stopNote ?? t("chat.panel.stop")}
            blocked={stopNote !== undefined}
            onClick={onStop}
          >
            <Square className="size-3" />
          </IconButton>
        )}
      </Row>
      <div className="truncate pl-5.5 text-app-micro text-muted-foreground">{metaOf(row, t)}</div>
      {open && agent && (
        <div className="mt-0.5 ml-5.5 flex flex-col gap-0.5 border-l border-border pl-2 text-app-micro">
          {agent.currentTool && (
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
      {open && job && jobDetail(job)}
    </div>
  );
});

/** A running row's way in: a subagent's transcript, a run, a job's output, a call in the conversation. */
function OpenButton({
  row,
  open,
  onToggle,
  onOpen,
}: {
  row: ActivityRow;
  open: boolean;
  onToggle: () => void;
  onOpen: (row: ActivityRow) => void;
}) {
  const { t } = useTranslation();
  if (row.job) {
    return (
      <IconButton
        label={t("chat.panel.running.output")}
        onClick={onToggle}
        aria-pressed={open}
        data-testid="running-output"
      >
        <SquareTerminal className="size-3.5" />
      </IconButton>
    );
  }
  if (row.call) {
    return (
      <IconButton label={t("chat.panel.jobs.show_call")} onClick={() => onOpen(row)}>
        <MessageSquare className="size-3.5" />
      </IconButton>
    );
  }
  return (
    <IconButton
      label={row.kind === "run" ? t("chat.panel.agents.open_run") : t("chat.panel.agents.open")}
      onClick={() => onOpen(row)}
      data-testid="running-open"
    >
      <ExternalLink className="size-3.5" />
    </IconButton>
  );
}

/**
 * What ended, as a fold that counts it; opened, a box to search it and the
 * newest first, a few and then the rest when asked.
 */
const EndedFold = memo(function EndedFold({
  rows,
  foldKey,
  opened,
  reveal,
  onRevealed,
  onOpen,
  jobDetail,
}: {
  rows: readonly ActivityRow[];
  /** Where it is kept open or folded. */
  foldKey: string;
  /** Set when it was asked to open: by a bare /tasks with nothing running, or for a row of it. */
  opened?: number;
  /** The job of its rows asked for. */
  reveal?: RunningReveal;
  onRevealed?: (seq: number) => void;
  onOpen: (row: ActivityRow) => void;
  jobDetail: (job: JobLike) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useFold(foldKey, false);
  const [query, setQuery] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once
  useEffect(() => {
    if (opened === undefined) return;
    setOpen(true);
    // The row asked for shows whatever was searched.
    setQuery("");
  }, [opened]);
  return (
    <Fold
      label={t("chat.panel.running.ended")}
      count={rows.length}
      open={open}
      onToggle={() => setOpen(!open)}
      testId="panel-ended"
    >
      <EndedList
        rows={rows}
        query={query}
        onQuery={setQuery}
        reveal={reveal}
        onRevealed={onRevealed}
        onOpen={onOpen}
        jobDetail={jobDetail}
      />
    </Fold>
  );
});

/** The ended rows opened: only while the fold is open, so a closed one costs nothing. */
function EndedList({
  rows,
  query,
  onQuery,
  reveal,
  onRevealed,
  onOpen,
  jobDetail,
}: {
  rows: readonly ActivityRow[];
  query: string;
  onQuery: (query: string) => void;
  reveal?: RunningReveal;
  onRevealed?: (seq: number) => void;
  onOpen: (row: ActivityRow) => void;
  jobDetail: (job: JobLike) => React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  // Typing stays quick however many rows: the list follows a moment after.
  const searched = useDeferredValue(query);
  const found = useMemo(() => searchActivity(rows, searched), [rows, searched]);
  // "3분 전" moves on while it is open.
  const now = useNow(true, 30_000);
  const asked = reveal?.id;
  const at = asked === undefined ? -1 : found.findIndex((row) => row.job?.taskId === asked);
  const justNow = t("chat.time.now");
  return (
    <div className="flex flex-col gap-0.5" data-testid="panel-ended-list">
      <SearchInput
        value={query}
        onChange={onQuery}
        label={t("chat.panel.running.search")}
        className="mb-0.5 h-6"
        data-testid="panel-ended-search"
      />
      {found.length === 0 ? (
        <div className="px-1 text-app-micro text-muted-foreground">
          {t("chat.panel.running.no_match")}
        </div>
      ) : (
        <FirstFew first={ENDED_FIRST} opened={at >= ENDED_FIRST ? reveal?.seq : undefined}>
          {found.map((row) => (
            <EndedRow
              key={row.key}
              row={row}
              ago={agoOf(row, now, i18n.language, justNow)}
              reveal={row.job && row.job.taskId === asked ? reveal?.seq : undefined}
              onRevealed={onRevealed}
              onOpen={onOpen}
              jobDetail={jobDetail}
            />
          ))}
        </FirstFew>
      )}
    </div>
  );
}

/** How long a row ran and how long ago it ended, as "3:12 · 8분 전". */
function agoOf(row: ActivityRow, now: number, locale: string, justNow: string): string {
  const took =
    row.startedAt !== undefined && row.endedAt !== undefined
      ? elapsedLabel(Math.max(0, row.endedAt - row.startedAt))
      : undefined;
  const at = endedAtOf(row);
  const ago = at !== undefined ? relativeTime(at, now, locale, justNow) : undefined;
  return [took, ago].filter(Boolean).join(" · ");
}

const EndedRow = memo(function EndedRow({
  row,
  ago,
  reveal,
  onRevealed,
  onOpen,
  jobDetail,
}: {
  row: ActivityRow;
  ago: string;
  reveal?: number;
  onRevealed?: (seq: number) => void;
  onOpen: (row: ActivityRow) => void;
  jobDetail: (job: JobLike) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { ref, lit } = useRevealedRow(reveal, () => setOpen(true), onRevealed);
  const job = row.job;
  const status = t(`chat.panel.status.${row.status}`);
  return (
    <div
      ref={ref}
      className={cn(
        "-mx-1 flex flex-col rounded-(--radius-control) px-1 transition-colors duration-500",
        lit && "bg-[var(--state-hover-bg)]",
      )}
      data-testid="ended-row"
      data-kind={row.kind}
    >
      <button
        type="button"
        onClick={job ? () => setOpen((v) => !v) : () => onOpen(row)}
        aria-expanded={job ? open : undefined}
        title={`${row.description} · ${status}`}
        className="flex min-h-6 min-w-0 items-center gap-1.5 rounded-(--radius-control) text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
      >
        <ActivityGlyph status={row.status} />
        <KindIcon kind={row.kind} />
        <span className="min-w-0 flex-1 truncate">{row.description}</span>
        {ago && (
          <span className="shrink-0 text-app-micro text-muted-foreground tabular-nums">{ago}</span>
        )}
      </button>
      {open && job && jobDetail(job)}
    </div>
  );
});
