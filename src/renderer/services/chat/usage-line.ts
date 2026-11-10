/**
 * The line under a chat tab's composer: how full the conversation's context
 * is and how much of the plan's usage limits is spent, from what the Claude
 * or Codex program last reported.
 */

import type { CodexLimitWindow, CodexModel } from "./codex-model";
import type { ChatModel } from "./model";
import { contextOf, usageLimitsOf } from "./panel";

/** Tokens as "942", "1k", "1.5k", "24.5k" or "1.2M". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  // Rounded first, so 999,960 is "1M", not "1000k".
  const thousands = Number((count / 1000).toFixed(1));
  if (thousands < 1000) return `${thousands}k`;
  return `${Number((count / 1_000_000).toFixed(1))}M`;
}

/** A usage window, as the line names it. */
export type UsageMeterKind =
  /** Claude's five-hour session. */
  | "session"
  /** The week, every model. */
  | "weekly"
  /** The week, one model (`scope`). */
  | "weekly_scoped"
  /** A Codex window of `windowMins`, other than the week. */
  | "window";

export interface UsageMeter {
  kind: UsageMeterKind;
  scope?: string;
  windowMins?: number;
  percent: number;
  /** When the window starts over, in milliseconds. */
  resetsAt?: number;
}

export interface UsageLine {
  context?: { percent: number; used: number; max: number };
  /** Shown in the line: the session's (or the short window's) and the week's. */
  meters: UsageMeter[];
  /** Told only on hover: the week's for one model. */
  more: UsageMeter[];
}

const WEEK_MINS = 7 * 24 * 60;

function percentOf(used: number, max: number): number {
  return Math.round((used / max) * 100);
}

/**
 * A window that has started over since it was read no longer says how
 * much is spent: it is left out until the next answer.
 */
function current(meter: UsageMeter, now: number): boolean {
  return meter.resetsAt === undefined || meter.resetsAt > now;
}

function lineOf(
  context: UsageLine["context"],
  meters: UsageMeter[],
  more: UsageMeter[],
  now: number,
): UsageLine | null {
  const shown = meters.filter((meter) => current(meter, now));
  const told = more.filter((meter) => current(meter, now));
  if (!context && shown.length === 0) return null;
  return { ...(context ? { context } : {}), meters: shown, more: told };
}

/** A Claude tab's line, from get_context_usage's and get_usage's last answers. */
export function claudeUsageLine(
  model: Pick<ChatModel, "contextUsage" | "usage">,
  now: number,
): UsageLine | null {
  const summary = contextOf(model.contextUsage);
  const context =
    summary && summary.maxTokens > 0
      ? {
          percent: percentOf(summary.totalTokens, summary.maxTokens),
          used: summary.totalTokens,
          max: summary.maxTokens,
        }
      : undefined;
  const meters: UsageMeter[] = [];
  const more: UsageMeter[] = [];
  for (const limit of usageLimitsOf(model.usage)) {
    const parsed = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
    const resetsAt = Number.isNaN(parsed) ? undefined : parsed;
    const base = { percent: limit.percent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
    if (limit.kind === "session") meters.push({ kind: "session", ...base });
    else if (limit.kind === "weekly_all") meters.push({ kind: "weekly", ...base });
    else if (limit.kind === "weekly_scoped" && limit.scope) {
      more.push({ kind: "weekly_scoped", scope: limit.scope, ...base });
    }
  }
  return lineOf(context, meters, more, now);
}

function codexMeter(window: CodexLimitWindow): UsageMeter {
  const resetsAt = window.resetsAt !== undefined ? window.resetsAt * 1000 : undefined;
  const base = {
    percent: window.usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
  if (window.windowMins === WEEK_MINS) return { kind: "weekly", ...base };
  return {
    kind: "window",
    ...(window.windowMins !== undefined ? { windowMins: window.windowMins } : {}),
    ...base,
  };
}

/** A Codex tab's line, from the thread's token usage and the plan's limits. */
export function codexUsageLine(
  model: Pick<CodexModel, "tokens" | "rateLimits">,
  now: number,
): UsageLine | null {
  const tokens = model.tokens;
  const context =
    tokens?.window && tokens.window > 0
      ? { percent: percentOf(tokens.used, tokens.window), used: tokens.used, max: tokens.window }
      : undefined;
  const windows = [model.rateLimits?.primary, model.rateLimits?.secondary].filter(
    (window): window is CodexLimitWindow => window !== undefined,
  );
  return lineOf(context, windows.map(codexMeter), [], now);
}

/** When a window starts over, in parts the line's words put together. */
export interface ResetParts {
  /** Within a day: the time alone says when. */
  soon: boolean;
  /** "15:00", on the 24-hour clock. */
  time: string;
  month: number;
  day: number;
  /** The day of the week, short, in the app's language: "목", "Thu". */
  weekday: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function resetParts(resetsAt: number, now: number, locale: string): ResetParts {
  const date = new Date(resetsAt);
  return {
    soon: resetsAt - now < DAY_MS,
    time: new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date),
  };
}

/** From this percent on, a part warns: its colour turns, and it holds out longest as the line narrows. */
export const WARN_AT = 80;

function near(percent: number): boolean {
  return percent >= WARN_AT;
}

/** How a meter shows in one step of the line. */
export interface UsageMeterView {
  meter: UsageMeter;
  bar: boolean;
  /** Its long name ("현재 세션") or its short one ("세션"). */
  word: "long" | "short";
  /** When it starts over, said whole, in short, or not at all. */
  reset: "long" | "short" | null;
}

/** What the line says in one step of narrowing. */
export interface UsageView {
  /** The context's ring and percent, with its word and its token counts, unless left out. */
  context?: { word: boolean; tokens: boolean };
  meters: UsageMeterView[];
  /** What is left out, counted after the meters ("+2") and told on hover. */
  hidden: { context: boolean; meters: UsageMeter[] };
  /** The profile's name after its dot; the dot alone otherwise. */
  profileName: boolean;
}

interface Detail {
  tokens: boolean;
  words: "long" | "short";
  /** Every meter's reset time, those near their limit, theirs in short, or none. */
  resets: "all" | "near" | "short" | "none";
  bars: boolean;
  profileName: boolean;
  /** Meters below WARN_AT show. */
  calm: boolean;
  /** The context shows below WARN_AT, while a meter is near its limit. */
  context: boolean;
}

const ALL: Detail = {
  tokens: true,
  words: "long",
  resets: "all",
  bars: true,
  profileName: true,
  calm: true,
  context: true,
};

/** What each step leaves out, on top of the steps before it: the least wanted first. */
const STEPS: Partial<Detail>[] = [
  { tokens: false },
  { resets: "near" },
  { words: "short", resets: "short" },
  { bars: false },
  { profileName: false },
  { calm: false },
  { context: false },
  { resets: "none" },
];

function viewOf(line: UsageLine, d: Detail): UsageView {
  const anyNear = line.meters.some((meter) => near(meter.percent));
  const { context } = line;
  // With nothing near its limit, the context is the most there is to say.
  const showContext = context !== undefined && (d.context || near(context.percent) || !anyNear);
  const shown = line.meters.filter((meter) => d.calm || near(meter.percent));
  const resetOf = (meter: UsageMeter): UsageMeterView["reset"] => {
    if (meter.resetsAt === undefined || d.resets === "none") return null;
    if (d.resets === "all") return "long";
    if (!near(meter.percent)) return null;
    return d.resets === "near" ? "long" : "short";
  };
  return {
    ...(showContext ? { context: { word: d.words === "long", tokens: d.tokens } } : {}),
    meters: shown.map((meter) => ({ meter, bar: d.bars, word: d.words, reset: resetOf(meter) })),
    hidden: {
      context: context !== undefined && !showContext,
      meters: line.meters.filter((meter) => !shown.includes(meter)),
    },
    profileName: d.profileName,
  };
}

/**
 * The line's steps, from all of it to the least it says, for a tab as
 * narrow as it gets: the token counts go first, then the reset times of
 * the meters not near their limit, then the words shorten, the bars go,
 * the profile keeps its dot alone, the meters not near their limit are
 * counted instead of shown, then the context, and last the reset times of
 * those near it. A step that would say the same as the one before is left
 * out; one without a profile after it (`profile: false`) has no step for
 * its name.
 */
export function usageViews(line: UsageLine, { profile = true } = {}): UsageView[] {
  const views: UsageView[] = [];
  let detail = ALL;
  for (const step of [{}, ...STEPS]) {
    detail = { ...detail, ...step };
    const view = viewOf(line, profile ? detail : { ...detail, profileName: false });
    const before = views.at(-1);
    if (!before || JSON.stringify(before) !== JSON.stringify(view)) views.push(view);
  }
  return views;
}
