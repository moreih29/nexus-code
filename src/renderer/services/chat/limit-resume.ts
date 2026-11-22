/**
 * Going on once the plan's usage limit resets. A subscription's plan (a
 * Claude account, Codex signed in with ChatGPT) stops a turn at its usage
 * limit, and neither program tries again: Claude Code tells when the limit
 * resets (a rate_limit_event, rejected, with resetsAt), Codex shows the
 * window used up and when it resets (account/rateLimits/updated). The tab
 * keeps when to go on, after the reset and a configurable delay. The app
 * sends the agent one message to go on, marked as the app's: one message goes
 * on with the work, whether the limit stopped it mid-turn or at its first
 * request (Claude Code 2.1, Codex 0.170).
 *
 * What a stop is, when to go on, and what to do then; pure.
 * limit-resume-scheduler runs it.
 */

import type { LimitResumeOptions } from "../../../shared/chat/limit-resume-settings";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { LimitResume } from "../../../shared/types/layout";
import { usageLimitsOf } from "./claude/usage-limits";
import type { CodexModel, CodexRateLimits } from "./codex/model";
import type { ChatModel } from "./model";
import type { PlanUsage } from "./plan-usage";
import { resetParts } from "./usage-line";

/** Tabs of one profile go this far apart, not all at once. */
export const STAGGER_MS = 5_000;
/** The plan's usage heard this recently tells whether the limit still holds. */
export const FRESH_PLAN_MS = 2 * 60_000;
/** A message that could not be sent is tried again this long after. */
export const RETRY_MS = 5 * 60_000;

/** A turn the plan's usage limit ended: when, and when the limit resets, if told. */
export interface LimitStop {
  stopAt: number;
  resetsAt?: number;
}

/**
 * The stop of the last turn, when the plan's usage limit ended it and no
 * other runs; null otherwise. The reset is the program's own: Claude Code's
 * rejected limit, Codex's used-up window.
 */
export function limitStopOf(model: ChatModel, agent: ChatAgent): LimitStop | null {
  const result = model.lastResult;
  if (model.running || result?.failure?.kind !== "usage_limit" || result.at === undefined) {
    return null;
  }
  const reset =
    agent === "claude"
      ? claudeRejectedUntil(model)
      : codexBlockedUntil((model as CodexModel).rateLimits);
  // A reset before the stop is an earlier limit's.
  const resetsAt = reset !== undefined && reset > result.at ? reset : undefined;
  return { stopAt: result.at, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function claudeRejectedUntil(model: ChatModel): number | undefined {
  const limit = model.rateLimit;
  if (limit?.status !== "rejected" || limit.resetsAt === undefined) return undefined;
  return limit.resetsAt * 1000;
}

/** When Codex's used-up windows reset, the latest of them; undefined when none is used up. */
export function codexBlockedUntil(limits: CodexRateLimits | undefined): number | undefined {
  let until: number | undefined;
  for (const window of [limits?.primary, limits?.secondary]) {
    if (!window || window.usedPercent < 100 || window.resetsAt === undefined) continue;
    until = Math.max(until ?? 0, window.resetsAt * 1000);
  }
  return until;
}

/**
 * When the plan's used-up limits reset, as its usage tells, the latest of
 * them; undefined when none is used up. A Claude limit of one model's is
 * left out: it holds that model only.
 */
export function planBlockedUntil(
  plan: PlanUsage | undefined,
  agent: ChatAgent,
): number | undefined {
  if (!plan) return undefined;
  if (agent === "codex") return codexBlockedUntil(plan.codex);
  let until: number | undefined;
  for (const limit of usageLimitsOf(plan.claude)) {
    if (limit.scope || limit.percent < 100) continue;
    const at = Date.parse(limit.resetsAt ?? "");
    if (Number.isFinite(at)) until = Math.max(until ?? 0, at);
  }
  return until;
}

/**
 * What a tab keeps for a stop: to go on after the reset and delay, or, with
 * no reset told, nothing to send. `tries`: the times the same limit was
 * waited out before; past the most, it gives up.
 */
export function planResume(
  stop: LimitStop,
  now: number,
  options: LimitResumeOptions,
  tries = 0,
  session?: string,
): LimitResume {
  const base = { stopAt: stop.stopAt, tries, ...(session ? { session } : {}) };
  if (stop.resetsAt === undefined) return { ...base, state: "unknown" };
  if (tries >= options.chatLimitResumeMaxTries) {
    return { ...base, resetsAt: stop.resetsAt, state: "gave_up" };
  }
  return {
    ...base,
    resetsAt: stop.resetsAt,
    at: Math.max(stop.resetsAt, now) + options.chatLimitResumeDelayMinutes * 60_000,
    state: "waiting",
  };
}

/** What a tab is, for what it keeps. */
export interface LimitTabView {
  agent: ChatAgent;
  /** Its conversation as it runs, when the tab has one in the app. */
  model?: ChatModel;
  /** The session or thread the tab has now. */
  session?: string;
  /** Its profile is a subscription's: a Claude account, or Codex with no API key. */
  subscription: boolean;
  /** The setting is on. */
  enabled: boolean;
  now: number;
  /** The latest stop the app already kept a record for, or let go. */
  handledAt?: number;
}

/**
 * What the tab keeps now, from what it kept and its conversation: the same
 * record while nothing changed, none once the conversation went on (a turn
 * the user started, another session, a turn that ended otherwise), and a
 * new one for a turn the limit stopped. A turn the app's own message
 * started keeps it; stopped at the limit again, it counts a try more.
 */
export function reconcileResume(
  record: LimitResume | undefined,
  view: LimitTabView,
  options: LimitResumeOptions,
): LimitResume | undefined {
  if (record && record.state !== "sent" && !view.enabled) return undefined;
  if (record?.session && view.session && record.session !== view.session) return undefined;
  if (
    (record?.state === "waiting" || record?.state === "unknown") &&
    resumeExpired(record.stopAt, view.now, options)
  ) {
    record = undefined;
  }
  if (record?.state === "waiting" && record.tries >= options.chatLimitResumeMaxTries) {
    record = giveUpResume(record);
  }
  const { model } = view;
  if (!model) return record;
  if (model.running) {
    const started = model.turn?.startedAt;
    if (record && record.state !== "sent" && started !== undefined && started > record.stopAt) {
      return undefined;
    }
    return record;
  }
  const at = model.lastResult?.at;
  if (at === undefined) return record;
  if (record && at <= record.stopAt) return record;
  if (!record && view.handledAt !== undefined && at <= view.handledAt) return record;
  const stop =
    view.enabled && view.subscription && !resumeExpired(at, view.now, options)
      ? limitStopOf(model, view.agent)
      : null;
  if (!stop) return undefined;
  return planResume(
    stop,
    view.now,
    options,
    record?.state === "sent" ? record.tries : 0,
    view.session,
  );
}

/** A record with no reset told, once the plan's usage tells one after its stop. */
export function withResetTime(
  record: LimitResume,
  resetsAt: number | undefined,
  now: number,
  options: LimitResumeOptions,
): LimitResume {
  if (record.state !== "unknown" || resetsAt === undefined || resetsAt <= record.stopAt) {
    return record;
  }
  return planResume(
    { stopAt: record.stopAt, resetsAt },
    now,
    options,
    record.tries,
    record.session,
  );
}

function resumeExpired(stopAt: number, now: number, options: LimitResumeOptions): boolean {
  return now - stopAt >= options.chatLimitResumeDeadlineHours * 3_600_000;
}

function giveUpResume(record: LimitResume): LimitResume {
  const { at: _was, ...rest } = record;
  return { ...rest, state: "gave_up" };
}

/** Whether the time to send has come. */
export function resumeDue(record: LimitResume | undefined, now: number): boolean {
  return record?.state === "waiting" && record.at !== undefined && record.at <= now;
}

/**
 * At the time to send, after the plan's usage was asked again: "send", or
 * the record put off to the reset the plan tells now, while the limit
 * still holds. Usage not heard just now, or no limit used up, sends.
 */
export function afterRecheck(
  record: LimitResume,
  blockedUntil: number | undefined,
  fresh: boolean,
  now: number,
  options: LimitResumeOptions,
): LimitResume | "send" {
  if (record.tries >= options.chatLimitResumeMaxTries) return giveUpResume(record);
  if (!fresh || blockedUntil === undefined || blockedUntil <= now) return "send";
  const tries = record.tries + 1;
  const { at: _was, ...rest } = record;
  if (tries >= options.chatLimitResumeMaxTries) {
    return { ...rest, tries, resetsAt: blockedUntil, state: "gave_up" };
  }
  return {
    ...rest,
    tries,
    resetsAt: blockedUntil,
    at: blockedUntil + options.chatLimitResumeDelayMinutes * 60_000,
  };
}

/** The record once the message went. */
export function sentResume(record: LimitResume, now: number): LimitResume {
  const { at: _was, ...rest } = record;
  return { ...rest, state: "sent", sentAt: now, tries: record.tries + 1 };
}

/** The record once the message could not be sent: tried again later, up to the most tries. */
export function failedResume(
  record: LimitResume,
  now: number,
  options: LimitResumeOptions,
): LimitResume {
  const tries = record.tries + 1;
  const { at: _was, sentAt: _sent, ...rest } = record;
  if (tries >= options.chatLimitResumeMaxTries) return { ...rest, tries, state: "gave_up" };
  return { ...rest, tries, state: "waiting", at: now + RETRY_MS };
}

/** A time as the banner and the agent list say it: "15:00", or "11/23 15:00" past a day. */
export function resumeTimeText(at: number, now: number, locale: string): string {
  const parts = resetParts(at, now, locale);
  return parts.soon ? parts.time : `${parts.month}/${parts.day} ${parts.time}`;
}
