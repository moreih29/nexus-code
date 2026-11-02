/**
 * The sessions tab's timeline: for each agent session of a workspace and its
 * tasks, its states over a stretch of time, its waits on other terminals,
 * and the agents it ran. Pure: built from the family and the spans main
 * recorded (cli.history).
 */

import type { ToolRun } from "../../../shared/claude/activity";
import type { SessionSpan, SpanAgent } from "../../../shared/sessions/history";
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

/** An agent a session ran, under the session's lane. */
export interface TimelineAgentLane {
  readonly agent: SpanAgent;
  readonly bars: readonly TimelineBar[];
  /** How it ended, "completed", "stopped" or "failed", and when; absent while it runs. */
  readonly outcome: { readonly state: string; readonly at: number } | undefined;
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
  /** The agents the session ran in the period, by when each began. */
  readonly agents: readonly TimelineAgentLane[];
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
  // The spans of a session's agents: by session, then by agent.
  const agentSpansOf = new Map<string, Map<string, SessionSpan[]>>();
  for (const span of spans) {
    const key = sessionKey(span.workspaceId, span.tabId);
    if (span.agent) {
      const agents = agentSpansOf.get(key) ?? new Map<string, SessionSpan[]>();
      agents.set(span.agent.id, [...(agents.get(span.agent.id) ?? []), span]);
      agentSpansOf.set(key, agents);
      continue;
    }
    if (!clip(span)) continue;
    spansOf.set(key, [...(spansOf.get(key) ?? []), span]);
  }
  const agentLanesOf = (key: string): TimelineAgentLane[] =>
    [...(agentSpansOf.get(key)?.values() ?? [])].flatMap((own) => {
      const agent = own[own.length - 1]?.agent;
      if (!agent) return [];
      const bars = own.flatMap((span) => {
        const time = !ENDINGS.has(span.state) && clip(span);
        return time
          ? [{ state: span.state, phase: phaseOf(span.state), estimated: false, ...time }]
          : [];
      });
      const ending = own.find((span) => ENDINGS.has(span.state));
      const outcome =
        ending && ending.start >= from && ending.start <= now
          ? { state: ending.state, at: ending.start }
          : undefined;
      return bars.length > 0 || outcome ? [{ agent, bars, outcome }] : [];
    });
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
    return {
      worktree,
      key,
      session,
      agent: session ? session.agent : "claude",
      bars,
      waits,
      agents: agentLanesOf(key),
    };
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
      : [
          {
            worktree,
            key: undefined,
            session: undefined,
            agent: undefined,
            bars: [],
            waits: [],
            agents: [],
          },
        ];
  });
  return { from, to: now, lanes, ticks: ticksBetween(from, now) };
}

/** The states of an agent's span with no length that tells how it ended. */
const ENDINGS = new Set(["completed", "stopped", "failed"]);

/** When the tools of `tools` that failed in the period failed, with each tool. */
export function failedTools(
  tools: readonly ToolRun[],
  from: number,
  now: number,
): { readonly at: number; readonly tool: ToolRun }[] {
  return tools.flatMap((tool) => {
    const at = tool.end ?? tool.start;
    return tool.failed && at >= from && at <= now ? [{ at, tool }] : [];
  });
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
