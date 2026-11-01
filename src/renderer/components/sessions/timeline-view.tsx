// Sessions tab — timeline view: a lane for each agent session of the
// workspace and its tasks, with bars for its states over the last 30
// minutes, 2 hours or today, and a dashed line under the stretches it spent
// waiting on another terminal. Choosing a lane shows it in the detail panel
// beside. Bars come from services/sessions/timeline.ts; main records them
// (cli.history) while the app runs.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { SessionFamily, SessionPhase } from "../../services/sessions/model";
import {
  buildTimeline,
  rangeStart,
  TIMELINE_RANGES,
  type TimelineBar,
  type TimelineLane,
  type TimelineRange,
  type TimelineWait,
} from "../../services/sessions/timeline";
import { useNow, useSessionHistory } from "../../services/sessions/use-family";
import { SegmentedControl } from "../settings/segmented-control";
import type { SessionsSelection } from "./selection";
import { AgentBadge, SessionState, stateLabel } from "./session-status";
import { rowClass } from "./tree-view";

interface TimelineViewProps {
  family: SessionFamily;
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
  visible: boolean;
}

// The colors of the states' glyphs (session-status.tsx), by phase. Bars of
// work and of the user's turn are thick; done and idle ones thin.
const BAR_CLASS: Record<SessionPhase, string> = {
  attention: "h-3 bg-(--state-warning-fg)",
  running: "h-3 bg-emerald-500",
  done: "h-1 bg-(--tab-claude-attention-fg)",
  idle: "h-1 bg-muted-foreground/50",
};
const ESTIMATED_CLASS = "h-3 bg-emerald-500/40";

// Label, track and current state; the state only where the view is wide
// enough, as the detail panel beside says it too.
const LANE_COLUMNS =
  "grid w-full grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 @xl:grid-cols-[10rem_minmax(0,1fr)_9rem]";
const STATE_COLUMN = "hidden min-w-0 @xl:block";

export function TimelineView({ family, selection, onSelect, visible }: TimelineViewProps) {
  const { t } = useTranslation();
  // The bars run up to now, so they move on with the clock while shown.
  const now = useNow(visible);
  const [range, setRange] = useState<TimelineRange>("30m");
  const ids = useMemo(() => family.worktrees.map((w) => w.workspace.id), [family]);
  const spans = useSessionHistory(ids, range, visible);
  const from = rangeStart(range, now);
  const timeline = useMemo(
    () => buildTimeline(family, spans, from, now),
    [family, spans, from, now],
  );
  const share = (time: number) => (time - timeline.from) / (timeline.to - timeline.from);
  const at = (time: number) => `${share(time) * 100}%`;
  const recorded = timeline.lanes.some((lane) => lane.bars.length > 0 || lane.waits.length > 0);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Legend />
        <div className="ml-auto">
          <SegmentedControl
            label={t("sessions.timeline.range_label")}
            options={TIMELINE_RANGES.map((value) => ({
              value,
              label: t(`sessions.timeline.range.${value}`),
            }))}
            value={range}
            onChange={setRange}
          />
        </div>
      </div>
      {!recorded && (
        <p className="text-app-ui-sm text-muted-foreground">{t("sessions.timeline.empty")}</p>
      )}
      <div className="@container flex flex-col gap-0.5">
        {timeline.lanes.map((lane) => (
          <Lane
            key={lane.key ?? lane.worktree.workspace.id}
            lane={lane}
            family={family}
            ticks={timeline.ticks}
            at={at}
            selected={isSelected(lane, selection)}
            onSelect={() =>
              onSelect(
                lane.session
                  ? { kind: "session", key: lane.session.key }
                  : { kind: "worktree", workspaceId: lane.worktree.workspace.id },
              )
            }
          />
        ))}
        <div className={cn(LANE_COLUMNS, "border-l-2 border-l-transparent px-2")}>
          <span />
          <span aria-hidden className="relative h-4 text-app-micro text-muted-foreground">
            {timeline.ticks
              // One at the right end would run out of the track or into the one before.
              .filter((tick) => share(tick) <= 0.9)
              .map((tick) => (
                <span
                  key={tick}
                  className="absolute -translate-x-1/2 whitespace-nowrap"
                  style={{ left: at(tick) }}
                >
                  {clockTime(tick)}
                </span>
              ))}
          </span>
          <span className={STATE_COLUMN} />
        </div>
      </div>
    </div>
  );
}

// An ended session's lane opens its worktree, but is not the one chosen.
function isSelected(lane: TimelineLane, selection: SessionsSelection | null): boolean {
  if (!lane.key) {
    return selection?.kind === "worktree" && selection.workspaceId === lane.worktree.workspace.id;
  }
  return selection?.kind === "session" && selection.key === lane.key;
}

function Legend() {
  const { t } = useTranslation();
  const items: { label: string; className: string }[] = [
    { label: t("sessions.phase.attention"), className: BAR_CLASS.attention },
    { label: t("sessions.phase.running"), className: BAR_CLASS.running },
    {
      label: t("sessions.estimated", { label: t("sessions.phase.running") }),
      className: ESTIMATED_CLASS,
    },
    { label: t("sessions.phase.done"), className: BAR_CLASS.done },
    { label: t("sessions.phase.idle"), className: BAR_CLASS.idle },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-app-micro text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("w-5 rounded-full", item.className)} />
          {item.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="w-5 border-t-2 border-dashed border-(--state-warning-fg)" />
        {t("sessions.timeline.legend_waiting")}
      </span>
    </div>
  );
}

function Lane({
  lane,
  family,
  ticks,
  at,
  selected,
  onSelect,
}: {
  lane: TimelineLane;
  family: SessionFamily;
  ticks: readonly number[];
  at: (time: number) => string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const { worktree, session } = lane;
  const maker = family.worktrees.find(
    (w) => w.workspace.id === worktree.workspace.task?.createdBy?.workspaceId,
  );
  const subtitle =
    session && worktree.sessions.length > 1
      ? session.title
      : maker && maker !== worktree
        ? t("sessions.timeline.made_by", { name: maker.workspace.name })
        : undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(rowClass(selected), LANE_COLUMNS, "py-1.5")}
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-app-body-emphasis text-foreground">
            {worktree.workspace.name}
          </span>
          {lane.key && <AgentBadge agent={lane.agent} />}
        </span>
        {subtitle && (
          <span className="truncate text-app-micro text-muted-foreground">{subtitle}</span>
        )}
      </span>
      <span className="relative h-6">
        {ticks.map((tick) => (
          <span
            key={tick}
            aria-hidden
            className="absolute inset-y-0 w-px bg-border"
            style={{ left: at(tick) }}
          />
        ))}
        {lane.bars.map((bar) => (
          <Bar key={`${bar.state}:${bar.start}`} bar={bar} at={at} />
        ))}
        {lane.waits.map((wait) => (
          <Wait key={wait.start} wait={wait} at={at} />
        ))}
      </span>
      <span className={STATE_COLUMN}>
        {session ? (
          <SessionState session={session} />
        ) : (
          <span className="text-app-ui-sm text-muted-foreground">
            {t(lane.key ? "sessions.state.exited" : "sessions.no_sessions")}
          </span>
        )}
      </span>
    </button>
  );
}

function Bar({ bar, at }: { bar: TimelineBar; at: (time: number) => string }) {
  return (
    <span
      title={`${stateLabel(bar)} · ${clockTime(bar.start)}–${clockTime(bar.end)}`}
      className={cn(
        "absolute top-1/2 min-w-0.5 -translate-y-1/2 rounded-full",
        bar.estimated ? ESTIMATED_CLASS : BAR_CLASS[bar.phase],
      )}
      style={{ left: at(bar.start), width: `calc(${at(bar.end)} - ${at(bar.start)})` }}
    />
  );
}

function Wait({ wait, at }: { wait: TimelineWait; at: (time: number) => string }) {
  const { t } = useTranslation();
  const label = wait.target
    ? t("sessions.timeline.waiting_on", { name: wait.target.workspace.name })
    : t("sessions.timeline.legend_waiting");
  return (
    <span
      title={`${label} · ${clockTime(wait.start)}–${clockTime(wait.end)}`}
      className="absolute bottom-0 min-w-0.5 border-t-2 border-dashed border-(--state-warning-fg)"
      style={{ left: at(wait.start), width: `calc(${at(wait.end)} - ${at(wait.start)})` }}
    />
  );
}

/** "14:05", in the local time. */
function clockTime(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
