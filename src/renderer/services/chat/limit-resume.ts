import type { LimitResumeOptions } from "../../../shared/chat/limit-resume-settings";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { LimitResume } from "../../../shared/types/layout";
import { usageLimitsOf } from "./claude/usage-limits";
import type { CodexModel, CodexRateLimits } from "./codex/model";
import type { ChatModel } from "./model";
import type { PlanUsage } from "./plan-usage";
import { resetParts } from "./usage-line";

export const STAGGER_MS = 5_000;
export const FRESH_PLAN_MS = 2 * 60_000;
export const RETRY_MS = 5 * 60_000;

export interface LimitStop {
  stopAt: number;
  resetsAt?: number;
}

export function limitStopOf(model: ChatModel, agent: ChatAgent): LimitStop | null {
  const result = model.lastResult;
  if (model.running || result?.failure?.kind !== "usage_limit" || result.at === undefined) {
    return null;
  }
  const reset =
    agent === "claude"
      ? claudeRejectedUntil(model)
      : codexBlockedUntil((model as CodexModel).rateLimits);
  const resetsAt = reset !== undefined && reset > result.at ? reset : undefined;
  return { stopAt: result.at, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

function claudeRejectedUntil(model: ChatModel): number | undefined {
  const limit = model.rateLimit;
  if (limit?.status !== "rejected" || limit.resetsAt === undefined) return undefined;
  return limit.resetsAt * 1000;
}

export function codexBlockedUntil(limits: CodexRateLimits | undefined): number | undefined {
  let until: number | undefined;
  for (const window of [limits?.primary, limits?.secondary]) {
    if (!window || window.usedPercent < 100 || window.resetsAt === undefined) continue;
    until = Math.max(until ?? 0, window.resetsAt * 1000);
  }
  return until;
}

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

export interface LimitTabView {
  agent: ChatAgent;
  model?: ChatModel;
  session?: string;
  subscription: boolean;
  enabled: boolean;
  now: number;
  handledAt?: number;
}

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

export function resumeDue(record: LimitResume | undefined, now: number): boolean {
  return record?.state === "waiting" && record.at !== undefined && record.at <= now;
}

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

export function sentResume(record: LimitResume, now: number): LimitResume {
  const { at: _was, ...rest } = record;
  return { ...rest, state: "sent", sentAt: now, tries: record.tries + 1 };
}

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

export function resumeTimeText(at: number, now: number, locale: string): string {
  const parts = resetParts(at, now, locale);
  return parts.soon ? parts.time : `${parts.month}/${parts.day} ${parts.time}`;
}
