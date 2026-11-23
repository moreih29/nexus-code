import { describe, expect, test } from "bun:test";
import type { CodexModel } from "../../../../../src/renderer/services/chat/codex/model";
import {
  afterRecheck,
  codexBlockedUntil,
  failedResume,
  type LimitTabView,
  limitStopOf,
  planBlockedUntil,
  planResume,
  RETRY_MS,
  reconcileResume,
  resumeDue,
  resumeTimeText,
  sentResume,
  withResetTime,
} from "../../../../../src/renderer/services/chat/limit-resume";
import { type ChatModel, emptyModel } from "../../../../../src/renderer/services/chat/model";
import type { PlanUsage } from "../../../../../src/renderer/services/chat/plan-usage";
import { LIMIT_RESUME_DEFAULTS as defaults } from "../../../../../src/shared/chat/limit-resume-settings";
import type { LimitResume } from "../../../../../src/shared/types/layout";
import { ClaudeTabPropsSchema } from "../../../../../src/shared/types/layout";

const STOP = Date.parse("2026-11-22T14:00:00+09:00");
const RESET = Date.parse("2026-11-22T15:00:00+09:00");
const RESUME_AFTER_MS = 60_000;
const STALE_STOP_MS = 12 * 3_600_000;

function claudeStopped(extra: Partial<ChatModel> = {}): ChatModel {
  return {
    ...emptyModel(),
    lastResult: {
      subtype: "success",
      isError: true,
      at: STOP,
      failure: { kind: "usage_limit", status: 429 },
    },
    rateLimit: { status: "rejected", resetsAt: RESET / 1000, rateLimitType: "five_hour" },
    ...extra,
  };
}

function codexStopped(extra: Partial<CodexModel> = {}): CodexModel {
  return {
    ...emptyModel(),
    lastResult: { subtype: "failed", isError: true, at: STOP, failure: { kind: "usage_limit" } },
    rateLimits: {
      primary: { usedPercent: 100, windowMins: 300, resetsAt: RESET / 1000 },
      secondary: { usedPercent: 40, windowMins: 10080, resetsAt: RESET / 1000 + 86_400 },
    },
    ...extra,
  } as CodexModel;
}

const view = (model: ChatModel | undefined, extra: Partial<LimitTabView> = {}): LimitTabView => ({
  agent: "claude",
  ...(model ? { model } : {}),
  session: "s-1",
  subscription: true,
  enabled: true,
  now: STOP + 1000,
  ...extra,
});

const waiting: LimitResume = {
  stopAt: STOP,
  resetsAt: RESET,
  at: RESET + RESUME_AFTER_MS,
  state: "waiting",
  tries: 0,
  session: "s-1",
};

describe("a stop at the usage limit", () => {
  test("Claude's: the turn's end, and the reset its rejected limit tells", () => {
    expect(limitStopOf(claudeStopped(), "claude")).toEqual({ stopAt: STOP, resetsAt: RESET });
  });

  test("Codex's: the reset of the window used up", () => {
    expect(limitStopOf(codexStopped(), "codex")).toEqual({ stopAt: STOP, resetsAt: RESET });
  });

  test("with no reset told, or an earlier limit's, has no reset", () => {
    expect(limitStopOf(claudeStopped({ rateLimit: undefined }), "claude")).toEqual({
      stopAt: STOP,
    });
    const earlier = { status: "rejected", resetsAt: (STOP - 60_000) / 1000 };
    expect(limitStopOf(claudeStopped({ rateLimit: earlier }), "claude")).toEqual({ stopAt: STOP });
  });

  test("is none while a turn runs, or for a turn that failed otherwise", () => {
    expect(limitStopOf(claudeStopped({ running: true }), "claude")).toBeNull();
    const transient = claudeStopped();
    transient.lastResult = {
      ...transient.lastResult!,
      failure: { kind: "transient", status: 529 },
    };
    expect(limitStopOf(transient, "claude")).toBeNull();
  });
});

describe("the plan's usage tells the reset", () => {
  test("Codex: the latest of the windows used up", () => {
    expect(
      codexBlockedUntil({
        primary: { usedPercent: 100, resetsAt: 100 },
        secondary: { usedPercent: 100, resetsAt: 200 },
      }),
    ).toBe(200_000);
    expect(codexBlockedUntil({ primary: { usedPercent: 99, resetsAt: 100 } })).toBeUndefined();
  });

  test("Claude: a full limit of the whole plan, not of one model", () => {
    const plan = (rateLimits: Record<string, unknown>): PlanUsage => ({
      claude: { rate_limits: rateLimits },
      failures: 0,
      nextAt: 0,
      lastAttemptAt: 0,
    });
    const resets = new Date(RESET).toISOString();
    expect(
      planBlockedUntil(plan({ five_hour: { utilization: 100, resets_at: resets } }), "claude"),
    ).toBe(RESET);
    expect(
      planBlockedUntil(plan({ five_hour: { utilization: 70, resets_at: resets } }), "claude"),
    ).toBeUndefined();
    const opus = {
      kind: "weekly_scoped",
      percent: 100,
      resets_at: resets,
      scope: { model: { display_name: "Opus" } },
    };
    expect(planBlockedUntil(plan({ limits: [opus] }), "claude")).toBeUndefined();
  });
});

describe("when to go on", () => {
  test("a minute after the reset; one already past, a minute from now", () => {
    expect(planResume({ stopAt: STOP, resetsAt: RESET }, STOP, defaults, 0, "s-1")).toEqual(
      waiting,
    );
    const late = RESET + 3_600_000;
    expect(planResume({ stopAt: STOP, resetsAt: RESET }, late, defaults).at).toBe(
      late + RESUME_AFTER_MS,
    );
  });

  test("with no reset told, nothing is scheduled", () => {
    expect(planResume({ stopAt: STOP }, STOP, defaults)).toEqual({
      stopAt: STOP,
      tries: 0,
      state: "unknown",
    });
  });

  test("a reset the plan's usage tells later schedules it", () => {
    const unknown = planResume({ stopAt: STOP }, STOP, defaults);
    expect(withResetTime(unknown, RESET, STOP, defaults).state).toBe("waiting");
    expect(withResetTime(unknown, STOP - 1, STOP, defaults)).toBe(unknown);
    expect(withResetTime(unknown, undefined, STOP, defaults)).toBe(unknown);
  });

  test("is due at its time, and only waiting", () => {
    expect(resumeDue(waiting, RESET)).toBe(false);
    expect(resumeDue(waiting, RESET + RESUME_AFTER_MS)).toBe(true);
    expect(resumeDue({ ...waiting, state: "cancelled" }, RESET + RESUME_AFTER_MS)).toBe(false);
  });

  test("the time reads as the hour, with the date past a day", () => {
    expect(resumeTimeText(RESET, STOP, "ko")).toBe(
      new Date(RESET).toLocaleTimeString("ko", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
    expect(resumeTimeText(RESET + 2 * 86_400_000, STOP, "en")).toMatch(/^\d+\/\d+ \d\d:\d\d$/);
  });
});

describe("what the tab keeps as its conversation goes", () => {
  test("a stop of a subscription's tab is kept, for its session", () => {
    expect(reconcileResume(undefined, view(claudeStopped()), defaults)).toEqual(waiting);
  });

  test("none for an API key's profile, the setting off, or a stop of long ago", () => {
    expect(
      reconcileResume(undefined, view(claudeStopped(), { subscription: false }), defaults),
    ).toBeUndefined();
    expect(
      reconcileResume(undefined, view(claudeStopped(), { enabled: false }), defaults),
    ).toBeUndefined();
    expect(
      reconcileResume(undefined, view(claudeStopped(), { now: STOP + STALE_STOP_MS }), defaults),
    ).toBeUndefined();
  });

  test("the same record while nothing changed, and after a restart replays the stop", () => {
    expect(reconcileResume(waiting, view(claudeStopped()), defaults)).toBe(waiting);
    expect(reconcileResume(waiting, view(undefined), defaults)).toBe(waiting);
  });

  test("a stop let go of is not kept again", () => {
    expect(
      reconcileResume(undefined, view(claudeStopped(), { handledAt: STOP }), defaults),
    ).toBeUndefined();
  });

  test("a turn the user starts calls it off; a turn replayed from before does not", () => {
    const running = (startedAt: number | undefined) =>
      claudeStopped({
        running: true,
        turn: { outputTokens: 0, thinkingTokens: 0, ...(startedAt ? { startedAt } : {}) },
      });
    expect(reconcileResume(waiting, view(running(STOP + 5000)), defaults)).toBeUndefined();
    expect(reconcileResume(waiting, view(running(STOP - 5000)), defaults)).toBe(waiting);
    expect(reconcileResume(waiting, view(running(undefined)), defaults)).toBe(waiting);
  });

  test("another session, or the setting turned off, calls it off", () => {
    expect(
      reconcileResume(waiting, view(claudeStopped(), { session: "s-2" }), defaults),
    ).toBeUndefined();
    expect(
      reconcileResume(waiting, view(claudeStopped(), { enabled: false }), defaults),
    ).toBeUndefined();
  });

  test("the app's message keeps it while it runs, and lets it go once a turn ends", () => {
    const sent = sentResume(waiting, RESET + RESUME_AFTER_MS);
    expect(sent).toMatchObject({ state: "sent", tries: 1, sentAt: RESET + RESUME_AFTER_MS });
    expect(sent.at).toBeUndefined();
    const going = claudeStopped({
      running: true,
      turn: { startedAt: RESET + RESUME_AFTER_MS, outputTokens: 0, thinkingTokens: 0 },
    });
    expect(reconcileResume(sent, view(going), defaults)).toBe(sent);
    const done = claudeStopped({
      lastResult: { subtype: "success", isError: false, at: RESET + 120_000 },
    });
    expect(reconcileResume(sent, view(done, { now: RESET + 120_000 }), defaults)).toBeUndefined();
  });

  test("stopped at the limit again after it, it counts a try more, and gives up at the most", () => {
    const later = RESET + 120_000;
    const again = claudeStopped({
      lastResult: {
        subtype: "success",
        isError: true,
        at: later,
        failure: { kind: "usage_limit" },
      },
      rateLimit: { status: "rejected", resetsAt: (later + 3_600_000) / 1000 },
    });
    const sent = sentResume(waiting, RESET + RESUME_AFTER_MS);
    expect(reconcileResume(sent, view(again, { now: later }), defaults)).toMatchObject({
      state: "waiting",
      tries: 1,
      stopAt: later,
    });
    const last = { ...sent, tries: defaults.chatLimitResumeMaxTries };
    expect(reconcileResume(last, view(again, { now: later }), defaults)).toMatchObject({
      state: "gave_up",
    });
  });
});

describe("at the time to send", () => {
  const due = RESET + RESUME_AFTER_MS;

  test("sends once the limit no longer holds, or usage was not heard just now", () => {
    expect(afterRecheck(waiting, undefined, true, due, defaults)).toBe("send");
    expect(afterRecheck(waiting, RESET, true, due, defaults)).toBe("send");
    expect(afterRecheck(waiting, RESET + 3_600_000, false, due, defaults)).toBe("send");
  });

  test("puts it off to the reset the plan tells now, up to the most tries", () => {
    const next = RESET + 3_600_000;
    expect(afterRecheck(waiting, next, true, due, defaults)).toMatchObject({
      state: "waiting",
      tries: 1,
      resetsAt: next,
      at: next + RESUME_AFTER_MS,
    });
    const last = afterRecheck(
      { ...waiting, tries: defaults.chatLimitResumeMaxTries - 1 },
      next,
      true,
      due,
      defaults,
    );
    expect(last).toMatchObject({ state: "gave_up", tries: defaults.chatLimitResumeMaxTries });
    expect(last !== "send" && last.at).toBeUndefined();
  });

  test("a message that could not go is tried again later", () => {
    const sent = sentResume(waiting, due);
    expect(failedResume(sent, due, defaults)).toMatchObject({
      state: "waiting",
      at: due + RETRY_MS,
    });
    expect(
      failedResume({ ...sent, tries: defaults.chatLimitResumeMaxTries - 1 }, due, defaults).state,
    ).toBe("gave_up");
  });
});

describe("the record in the layout", () => {
  test("is kept with the tab, and one the app cannot read is left out, not the tab", () => {
    const props = { cwd: "/p", limitResume: waiting };
    expect(ClaudeTabPropsSchema.parse(props).limitResume).toEqual(waiting);
    const odd = { cwd: "/p", limitResume: { ...waiting, state: "snoozed" } };
    expect(ClaudeTabPropsSchema.parse(odd)).toEqual({ cwd: "/p" });
  });
});
