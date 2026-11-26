import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import i18next from "i18next";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LimitResume } from "../../../../../src/shared/types/layout";

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: () => Promise.resolve({ ok: true, value: undefined }),
}));

const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useNotificationsStore } = await import(
  "../../../../../src/renderer/state/stores/notifications"
);
const { chatKey, useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { emptyModel } = await import("../../../../../src/renderer/services/chat/model");
const { ingestClaudeUsage, planUsageKeyFor, resetPlanUsage } = await import(
  "../../../../../src/renderer/services/chat/plan-usage"
);
const { STAGGER_MS } = await import("../../../../../src/renderer/services/chat/limit-resume");
const scheduler = await import("../../../../../src/renderer/services/chat/limit-resume-scheduler");
const { LimitResumeBanner, LimitResumeView } = await import(
  "../../../../../src/renderer/components/chat/limit-resume-banner"
);
const { BannerDismissButton } = await import("../../../../../src/renderer/components/ui/banner");

import type { BannerProps } from "../../../../../src/renderer/components/ui/banner";

const { cancelLimitResume, limitResumeIo, resetLimitResume, resumeLimitNow, tickLimitResume } =
  scheduler;

const WS = "ws-limit";
const RESUME_AFTER_MS = 60_000;
const io = { ...limitResumeIo };
let sent: { tabId: string; text: string }[] = [];
let slept: number[] = [];
let asks = 0;
let stillBlockedUntil: number | undefined;

beforeEach(() => {
  resetLimitResume();
  resetPlanUsage();
  sent = [];
  slept = [];
  asks = 0;
  stillBlockedUntil = undefined;
  useNotificationsStore.getState().hydrate({});
  useNotificationsStore.setState({ dismissedBanners: new Map() });
  limitResumeIo.send = async (_ws, tabId, text) => {
    sent.push({ tabId, text });
  };
  limitResumeIo.sleep = async (ms) => {
    slept.push(ms);
  };
  limitResumeIo.askPlan = async () => {
    asks++;
    const resets = new Date(stillBlockedUntil ?? Date.now() - 1000).toISOString();
    const utilization = stillBlockedUntil === undefined ? 0 : 100;
    ingestClaudeUsage(
      planUsageKeyFor("claude", WS, undefined),
      { rate_limits: { five_hour: { utilization, resets_at: resets } } },
      Date.now(),
    );
  };
});

afterEach(() => {
  Object.assign(limitResumeIo, io);
  useNotificationsStore.getState().hydrate({});
  useTabsStore.setState((state) => {
    const { [WS]: _gone, ...rest } = state.byWorkspace;
    return { byWorkspace: rest };
  });
  useChatStore.setState((state) => ({
    tabs: Object.fromEntries(
      Object.entries(state.tabs).filter(([key]) => !key.startsWith(`${WS}:`)),
    ),
  }));
});

function stoppedTab(ago: number, resetsAt: number | undefined): string {
  const tab = useTabsStore.getState().createTab(WS, {
    type: "claude",
    props: { cwd: "/p", sessionId: "s-1" },
  });
  const at = Date.now() - ago;
  useChatStore.getState().update(chatKey(WS, tab.id), (prev) => ({
    ...prev,
    model: {
      ...emptyModel(),
      sessionId: "s-1",
      lastResult: {
        subtype: "success",
        isError: true,
        at,
        failure: { kind: "usage_limit", status: 429 },
      },
      ...(resetsAt !== undefined
        ? { rateLimit: { status: "rejected", resetsAt: resetsAt / 1000 } }
        : {}),
    },
  }));
  return tab.id;
}

function dueTab(ago = 3 * 3_600_000): string {
  const resetsAt = Date.now() - 2 * RESUME_AFTER_MS;
  const tabId = stoppedTab(ago, resetsAt);
  const stopAt = Date.now() - ago;
  const model = useChatStore.getState().tabs[chatKey(WS, tabId)]?.model;
  useTabsStore.getState().setLimitResume(WS, tabId, {
    stopAt: model?.lastResult?.at ?? stopAt,
    resetsAt,
    at: Date.now() - 1000,
    state: "waiting",
    tries: 0,
    session: "s-1",
  });
  return tabId;
}

function recordOf(tabId: string) {
  const tab = useTabsStore.getState().byWorkspace[WS]?.[tabId];
  return tab?.type === "claude" ? tab.props.limitResume : undefined;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function clickResumeDismiss(scope: string[], record: LimitResume) {
  let click: (() => void) | undefined;
  function Probe() {
    const view = LimitResumeView({ scope, record });
    if (isValidElement<{ children: ReactElement<BannerProps> }>(view)) {
      const dismiss = view.props.children.props.dismiss;
      if (dismiss) click = BannerDismissButton({ dismiss }).props.onClick;
    }
    return view;
  }
  expect(renderToStaticMarkup(createElement(Probe))).toContain('aria-label="Dismiss"');
  expect(click).toBeDefined();
  click?.();
}

describe("a tab the usage limit stopped", () => {
  test("dismissing the resume banner keeps its schedule and a new stop shows again", async () => {
    const tabId = dueTab(13 * 3_600_000);
    const record = recordOf(tabId);
    if (!record) throw new Error("missing resume schedule");
    const render = (next: LimitResume, tab = tabId) =>
      renderToStaticMarkup(
        createElement(LimitResumeBanner, { workspaceId: WS, tabId: tab, record: next }),
      );

    expect(render(record)).toContain('aria-label="Dismiss"');
    clickResumeDismiss(["chat", WS, tabId, "s-1"], record);
    const resumeMessage = "Continue the dismissed reservation";
    useNotificationsStore.getState().hydrate({
      chatLimitResumeDeadlineHours: 24,
      chatLimitResumeMessage: resumeMessage,
    });
    expect(render({ ...record })).toBe("");
    expect(render({ ...record, stopAt: record.stopAt + 1 })).toContain('aria-label="Dismiss"');
    expect(render({ ...record, session: "s-2" })).toContain('aria-label="Dismiss"');
    expect(render(record, "another-tab")).toContain('aria-label="Dismiss"');
    expect(recordOf(tabId)).toEqual(record);

    tickLimitResume();
    await settle();
    expect(sent).toEqual([{ tabId, text: resumeMessage }]);
    expect(recordOf(tabId)).toMatchObject({ state: "sent" });
  });

  test("a remote unknown limit with a new stop time shows even with identical copy", () => {
    const scope = ["remote-chat", "device", WS, "tab", "session"];
    const record: LimitResume = { state: "unknown", stopAt: 1, tries: 0 };
    const render = (stopAt: number) =>
      renderToStaticMarkup(
        createElement(LimitResumeView, { scope, record: { ...record, stopAt } }),
      );
    clickResumeDismiss(scope, record);
    expect(render(1)).toBe("");
    expect(render(2)).toContain('aria-label="Dismiss"');
  });

  test("a reset already past: a minute from now", () => {
    const tabId = stoppedTab(3 * 3_600_000, Date.now() - 2 * RESUME_AFTER_MS);
    tickLimitResume();
    const at = recordOf(tabId)?.at ?? 0;
    expect(at - Date.now()).toBeGreaterThan(RESUME_AFTER_MS - 1000);
    expect(sent).toEqual([]);
  });

  test("keeps when to go on: a minute after the reset", () => {
    const resetsAt = Date.now() + 3_600_000;
    const tabId = stoppedTab(1000, resetsAt);
    tickLimitResume();
    expect(recordOf(tabId)).toMatchObject({
      state: "waiting",
      resetsAt,
      at: resetsAt + RESUME_AFTER_MS,
      session: "s-1",
    });
    expect(sent).toEqual([]);
  });

  test("a new delay applies to new reservations and keeps the existing scheduled time", () => {
    const resetsAt = Date.now() + 3_600_000;
    const existing = stoppedTab(1000, resetsAt);
    tickLimitResume();
    useNotificationsStore.getState().hydrate({ chatLimitResumeDelayMinutes: 0 });
    const next = stoppedTab(1000, resetsAt);
    tickLimitResume();
    expect(recordOf(existing)?.at).toBe(resetsAt + RESUME_AFTER_MS);
    expect(recordOf(next)?.at).toBe(resetsAt);
  });

  test("at its time, the limit gone, gets the message to go on, once", async () => {
    const tabId = dueTab();
    tickLimitResume();
    tickLimitResume();
    await settle();
    await settle();
    expect(asks).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tabId).toBe(tabId);
    expect(recordOf(tabId)).toMatchObject({ state: "sent", tries: 1 });
  });

  test("while the plan's usage still shows the limit used up, it is put off to the new reset", async () => {
    const tabId = dueTab();
    stillBlockedUntil = Date.now() + 1_800_000;
    useNotificationsStore.getState().hydrate({ chatLimitResumeDelayMinutes: 15 });
    tickLimitResume();
    await settle();
    expect(sent).toEqual([]);
    expect(recordOf(tabId)).toMatchObject({
      state: "waiting",
      tries: 1,
      at: stillBlockedUntil + 15 * 60_000,
    });
  });

  test("a recheck that still finds a limit stops at the configured max", async () => {
    const tabId = dueTab();
    stillBlockedUntil = Date.now() + 1_800_000;
    useNotificationsStore.getState().hydrate({ chatLimitResumeMaxTries: 1 });
    tickLimitResume();
    await settle();
    expect(asks).toBe(1);
    expect(sent).toEqual([]);
    expect(recordOf(tabId)).toMatchObject({ state: "gave_up", tries: 1 });
    expect(recordOf(tabId)?.at).toBeUndefined();
  });

  test("a lower max stops a saved reservation that has already used its attempts", () => {
    const tabId = dueTab();
    const record = recordOf(tabId);
    if (!record) throw new Error("expected a saved reservation");
    useTabsStore.getState().setLimitResume(WS, tabId, { ...record, tries: 2 });
    useNotificationsStore.getState().hydrate({ chatLimitResumeMaxTries: 1 });
    tickLimitResume();
    expect(recordOf(tabId)).toMatchObject({ state: "gave_up", tries: 2 });
    expect(recordOf(tabId)?.at).toBeUndefined();
    expect(asks).toBe(0);
    expect(sent).toEqual([]);
  });

  test("an expired saved reservation is discarded before probing or sending", () => {
    const expired = dueTab();
    useNotificationsStore.getState().hydrate({ chatLimitResumeDeadlineHours: 2 });
    tickLimitResume();
    expect(recordOf(expired)).toBeUndefined();
    expect(asks).toBe(0);
    expect(sent).toEqual([]);
  });

  test("a longer deadline accepts a stop older than the default deadline", async () => {
    const tabId = dueTab(13 * 3_600_000);
    useNotificationsStore.getState().hydrate({ chatLimitResumeDeadlineHours: 24 });
    tickLimitResume();
    await settle();
    expect(recordOf(tabId)?.state).toBe("sent");
  });

  test("checks the latest deadline again after an in-flight probe", async () => {
    const tabId = dueTab();
    limitResumeIo.askPlan = async () => {
      useNotificationsStore.getState().hydrate({ chatLimitResumeDeadlineHours: 2 });
    };
    tickLimitResume();
    await settle();
    expect(sent).toEqual([]);
    tickLimitResume();
    expect(recordOf(tabId)).toBeUndefined();
  });

  test("sends the configured text for an existing reservation", async () => {
    const tabId = dueTab();
    useNotificationsStore.getState().hydrate({ chatLimitResumeMessage: "Continue the review" });
    tickLimitResume();
    await settle();
    expect(sent).toEqual([{ tabId, text: "Continue the review" }]);
  });

  test.each([
    { message: "", language: "en" },
    { message: "  ", language: "ko" },
  ])("sends the $language default for a blank message", async ({ message, language }) => {
    const previous = i18next.language;
    try {
      await i18next.changeLanguage(language);
      const tabId = dueTab();
      useNotificationsStore.getState().hydrate({ chatLimitResumeMessage: message });
      tickLimitResume();
      await settle();
      expect(sent).toEqual([{ tabId, text: i18next.t("common:chat.limit_resume.prompt") }]);
    } finally {
      await i18next.changeLanguage(previous);
    }
  });

  test("tabs of one profile go a few seconds apart", async () => {
    dueTab();
    dueTab();
    tickLimitResume();
    for (let i = 0; i < 4; i++) await settle();
    expect(sent).toHaveLength(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(STAGGER_MS - 1000);
  });

  test("a message the user sends calls it off", () => {
    const tabId = stoppedTab(1000, Date.now() + 3_600_000);
    tickLimitResume();
    useChatStore.getState().update(chatKey(WS, tabId), (prev) => ({
      ...prev,
      model: {
        ...prev.model,
        running: true,
        turn: { startedAt: Date.now(), outputTokens: 0, thinkingTokens: 0 },
      },
    }));
    tickLimitResume();
    expect(recordOf(tabId)).toBeUndefined();
  });

  test("cancelled, it is not sent; [Resume now] sends at once without asking", async () => {
    const tabId = dueTab();
    tickLimitResume();
    cancelLimitResume(WS, tabId);
    await settle();
    tickLimitResume();
    await settle();
    expect(recordOf(tabId)?.state).toBe("cancelled");
    expect(sent).toEqual([]);
    await resumeLimitNow(WS, tabId);
    expect(sent).toHaveLength(1);
    expect(recordOf(tabId)?.state).toBe("sent");
  });

  test("with no reset told, asks the plan's usage once, and schedules by what it tells", async () => {
    const tabId = stoppedTab(1000, undefined);
    stillBlockedUntil = Date.now() + 3_600_000;
    useNotificationsStore.getState().hydrate({ chatLimitResumeDelayMinutes: 7 });
    tickLimitResume();
    tickLimitResume();
    await settle();
    expect(asks).toBe(1);
    expect(recordOf(tabId)).toMatchObject({
      state: "waiting",
      resetsAt: stillBlockedUntil,
      at: stillBlockedUntil + 7 * 60_000,
    });
  });

  test("the setting off keeps nothing", () => {
    useNotificationsStore.getState().setLimitResume(false);
    const tabId = stoppedTab(1000, Date.now() + 3_600_000);
    tickLimitResume();
    expect(recordOf(tabId)).toBeUndefined();
  });

  test("a message that cannot be sent is tried again, up to the most tries", async () => {
    limitResumeIo.send = async () => {
      throw new Error("the tab is gone");
    };
    const tabId = dueTab();
    tickLimitResume();
    for (let i = 0; i < 3; i++) await settle();
    expect(recordOf(tabId)).toMatchObject({ state: "waiting", tries: 1 });
  });

  test("a failed send stops at the configured max", async () => {
    const tabId = dueTab();
    useNotificationsStore.getState().hydrate({ chatLimitResumeMaxTries: 1 });
    limitResumeIo.send = async () => {
      throw new Error("the tab is gone");
    };
    tickLimitResume();
    await settle();
    expect(recordOf(tabId)).toMatchObject({ state: "gave_up", tries: 1 });
    expect(recordOf(tabId)?.at).toBeUndefined();
  });
});
