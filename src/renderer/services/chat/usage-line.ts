import { dateTimeFormat } from "../../utils/intl-format";
import type { CodexLimitWindow, CodexModel } from "./codex/model";
import type { ChatModel } from "./model";
import { contextOf, usageLimitsOf } from "./panel";

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const thousands = (count / 1000).toFixed(1);
  if (Number(thousands) < 1000) return `${thousands}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export type UsageMeterKind = "session" | "weekly" | "weekly_scoped" | "window";

export interface UsageMeter {
  kind: UsageMeterKind;
  scope?: string;
  windowMins?: number;
  percent: number;
  resetsAt?: number;
}

export interface UsageLine {
  context?: { percent: number; used: number; max: number };
  meters: UsageMeter[];
  more: UsageMeter[];
}

const WEEK_MINS = 7 * 24 * 60;

function percentOf(used: number, max: number): number {
  return Math.round((used / max) * 100);
}

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

export function codexMeter(window: CodexLimitWindow): UsageMeter {
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

export interface ResetParts {
  soon: boolean;
  time: string;
  month: number;
  day: number;
  weekday: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RESET_TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};
const RESET_WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "short" };

export function shownReset(resetsAt: number): Date {
  return new Date(Math.round(resetsAt / 60_000) * 60_000);
}

export function resetParts(resetsAt: number, now: number, locale: string): ResetParts {
  const date = shownReset(resetsAt);
  return {
    soon: resetsAt - now < DAY_MS,
    time: dateTimeFormat(locale, RESET_TIME).format(date),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: dateTimeFormat(locale, RESET_WEEKDAY).format(date),
  };
}

export const WARN_AT = 80;
export const ALERT_AT = 95;

export function meterLevel(percent: number): "alert" | "warn" | null {
  if (percent >= ALERT_AT) return "alert";
  return percent >= WARN_AT ? "warn" : null;
}

function near(percent: number): boolean {
  return percent >= WARN_AT;
}

export interface UsageMeterView {
  meter: UsageMeter;
  bar: boolean;
  word: "long" | "short";
  reset: "long" | "short" | null;
}

export interface UsageView {
  context?: { word: boolean; tokens: boolean };
  meters: UsageMeterView[];
  hidden: { context: boolean; meters: UsageMeter[] };
  profileName: boolean;
}

interface Detail {
  tokens: boolean;
  words: "long" | "short";
  resets: "all" | "near" | "short" | "none";
  bars: boolean;
  profileName: boolean;
  calm: boolean;
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
