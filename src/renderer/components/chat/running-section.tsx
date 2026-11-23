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
import { relativeTime } from "../../utils/time-format";
import { elapsedLabel } from "../agent-list/agent-status";
import { IconButton } from "../ui/icon-button";
import { SearchInput } from "../ui/search-input";
import { FirstFew, Row, Section, useFold, useRevealedRow } from "./panel-section";
import { BackgroundBadge, BackgroundIcon } from "./tool-row";

export const ENDED_FIRST = 5;

export interface RunningReveal {
  seq: number;
  id?: string;
}

export interface ActivitySectionsProps {
  activity: Activity;
  foldKey: string;
  reveal?: RunningReveal;
  onRevealed?: (seq: number) => void;
  onOpen: (row: ActivityRow) => void;
  stopOf: (row: ActivityRow) => (() => void) | undefined;
  stopNote?: string;
  onBackground?: (toolUseId: string) => void;
  jobDetail: (job: JobLike) => React.ReactNode;
}

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

function useShownRunning(rows: ActivityRow[]): ActivityRow[] {
  const seen = useRef(new Map<string, number>());
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
  const kept = useRef(activity.ended);
  if (!sameEndedRows(kept.current, activity.ended)) kept.current = activity.ended;
  const ended = kept.current;
  const asked = reveal?.id;
  const runningAsked = asked !== undefined && running.some((row) => row.job?.taskId === asked);
  const endedAsked = asked !== undefined && ended.some((row) => row.job?.taskId === asked);
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
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground", empty && "opacity-40")}
          />
        )}
        <span className="min-w-0 truncate">{label}</span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
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

function RunningFor({ from }: { from?: number }) {
  const now = useNow(from !== undefined);
  if (from === undefined) return null;
  return (
    <span className="shrink-0 text-app-micro text-muted-foreground tabular-nums">
      {elapsedLabel(Math.max(0, now - from))}
    </span>
  );
}

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
  foldKey: string;
  opened?: number;
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
  const searched = useDeferredValue(query);
  const found = useMemo(() => searchActivity(rows, searched), [rows, searched]);
  const now = useNow(true, 30_000);
  const asked = reveal?.id;
  const at = asked === undefined ? -1 : found.findIndex((row) => row.job?.taskId === asked);
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
              ago={agoOf(row, now, i18n.language)}
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

function agoOf(row: ActivityRow, now: number, locale: string): string {
  const took =
    row.startedAt !== undefined && row.endedAt !== undefined
      ? elapsedLabel(Math.max(0, row.endedAt - row.startedAt))
      : undefined;
  const at = endedAtOf(row);
  const ago = at !== undefined ? relativeTime(at, now, locale) : undefined;
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
