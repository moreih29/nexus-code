/**
 * The sessions tab's timeline: for each agent session of a workspace and its
 * tasks, its states over a stretch of time and its waits on other
 * terminals. Pure: built from the family and the spans main recorded
 * (cli.history).
 */

import type { SessionSpan } from "../../../shared/sessions/history";
import {
  type AgentSession,
  phaseOf,
  type SessionFamily,
  type SessionPhase,
  sessionKey,
  type WorktreeEntry,
} from "./model";

export const TIMELINE_RANGES = ["30m", "2h", "today"] as const;
export type TimelineRange = (typeof TIMELINE_RANGES)[number];

const MINUTE = 60_000;

/** Where `range` starts when it ends `now`; "today" starts at local midnight. */
export function rangeStart(range: TimelineRange, now: number): number {
  switch (range) {
    case "30m":
      return now - 30 * MINUTE;
    case "2h":
      return now - 120 * MINUTE;
    case "today":
      return localMidnight(now);
  }
}

function localMidnight(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export interface TimelineBar {
  readonly state: string;
  readonly phase: SessionPhase;
  /** Told from output, not reported by hooks. */
  readonly estimated: boolean;
  readonly start: number;
  readonly end: number;
}

export interface TimelineWait {
  readonly start: number;
  readonly end: number;
  /** The worktree waited on, when it is in the family. */
  readonly target: WorktreeEntry | undefined;
}

export interface TimelineLane {
  readonly worktree: WorktreeEntry;
  /**
   * The terminal's `${workspaceId}:${tabId}`; undefined for the empty lane of
   * a worktree with no session.
   */
  readonly key: string | undefined;
  /** The live session; undefined for an ended one and for an empty lane. */
  readonly session: AgentSession | undefined;
  readonly agent: string | undefined;
  readonly bars: readonly TimelineBar[];
  readonly waits: readonly TimelineWait[];
}

export interface Timeline {
  readonly from: number;
  readonly to: number;
  readonly lanes: readonly TimelineLane[];
  /** Round clock times to mark on the axis. */
  readonly ticks: readonly number[];
}

/**
 * A lane per live session, then one per ended Claude Code session with
 * states in the period (its terminal closed, or the app restarted), and
 * one for each worktree with neither. A terminal that only printed is no
 * session once it ends: a shell's output looks the same.
 */
export function buildTimeline(
  family: SessionFamily,
  spans: readonly SessionSpan[],
  from: number,
  now: number,
): Timeline {
  const clip = (span: SessionSpan) => {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end ?? now, now);
    return end > start ? { start, end } : null;
  };
  const spansOf = new Map<string, SessionSpan[]>();
  for (const span of spans) {
    if (!clip(span)) continue;
    const key = sessionKey(span.workspaceId, span.tabId);
    spansOf.set(key, [...(spansOf.get(key) ?? []), span]);
  }
  const worktreeOf = (workspaceId: string) =>
    family.worktrees.find((w) => w.workspace.id === workspaceId);

  const laneOf = (
    worktree: WorktreeEntry,
    key: string,
    session: AgentSession | undefined,
  ): TimelineLane => {
    const own = spansOf.get(key) ?? [];
    const bars = own.flatMap((span) => {
      const time = span.state !== "waiting" && clip(span);
      return time
        ? [
            {
              state: span.state,
              phase: phaseOf(span.state),
              estimated: span.state === "busy",
              ...time,
            },
          ]
        : [];
    });
    const waits = own.flatMap((span) => {
      const time = span.state === "waiting" && clip(span);
      return time ? [{ ...time, target: span.target && worktreeOf(span.target.workspaceId) }] : [];
    });
    return { worktree, key, session, agent: session ? session.agent : "claude", bars, waits };
  };

  const lanes = family.worktrees.flatMap((worktree): TimelineLane[] => {
    const live = new Set(worktree.sessions.map((s) => s.key));
    const ended = [...spansOf].filter(
      ([key, own]) =>
        !live.has(key) &&
        own[0]?.workspaceId === worktree.workspace.id &&
        own.some((span) => span.state !== "busy" && span.state !== "waiting"),
    );
    const own = [
      ...worktree.sessions.map((session) => laneOf(worktree, session.key, session)),
      ...ended.map(([key]) => laneOf(worktree, key, undefined)),
    ];
    return own.length > 0
      ? own
      : [{ worktree, key: undefined, session: undefined, agent: undefined, bars: [], waits: [] }];
  });
  return { from, to: now, lanes, ticks: ticksBetween(from, now) };
}

const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 240].map((minutes) => minutes * MINUTE);
const MAX_TICKS = 6;

/** Round clock times between `from` and `to`, at most MAX_TICKS of them. */
export function ticksBetween(from: number, to: number): number[] {
  const step =
    TICK_STEPS.find((s) => (to - from) / s <= MAX_TICKS) ?? (TICK_STEPS.at(-1) as number);
  const midnight = localMidnight(from);
  const ticks: number[] = [];
  for (let t = midnight + Math.ceil((from - midnight) / step) * step; t <= to; t += step) {
    ticks.push(t);
  }
  return ticks;
}
