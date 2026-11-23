/** A consent prompt answered on another device of the user's comes down here, saying so. */
import { describe, expect, mock, test } from "bun:test";
import i18next from "i18next";
import { Dialog as RadixDialog } from "radix-ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  askCliConsent,
  CliConsentDialogRoot,
  consentNamesTarget,
  consentTitleOf,
  describeConsent,
  settleCliConsent,
} from "../../../../../src/renderer/components/cli/consent-dialog";
import type { DialogProps } from "../../../../../src/renderer/components/ui/dialog";
import { type ToastInput, watchToasts } from "../../../../../src/renderer/components/ui/toast";
import { consentDetailsOf } from "../../../../../src/shared/cli/consent-copy";

// Static rendering omits the portal. Keep the Radix context for the dialog header.
mock.module("../../../../../src/renderer/components/ui/dialog", () => ({
  Dialog: ({ open, children }: DialogProps) =>
    open ? createElement(RadixDialog.Root, { open }, children) : null,
}));

const prompt = (id?: string) => ({
  ...(id ? { id } : {}),
  fromWorkspace: "app",
  fromTab: "zsh",
  toWorkspace: "api",
  change: { kind: "chatInput" as const, detail: "Review" },
  timeoutMs: 60_000,
});

for (const [eachTime, labels] of [
  [true, ["Don&#x27;t allow", "Allow"]],
  [false, ["Don&#x27;t allow", "Allow until restart", "Allow once"]],
] as const) {
  test(`the dialog shows the expected choices when eachTime is ${eachTime}`, async () => {
    const request = prompt("button-labels");
    const asked = askCliConsent({ ...request, change: { ...request.change, eachTime } });
    try {
      const html = renderToStaticMarkup(createElement(CliConsentDialogRoot));
      expect(
        Array.from(html.matchAll(/<button[^>]*>([^<]*)<\/button>/g), ([, label]) => label),
      ).toEqual(labels);
    } finally {
      settleCliConsent("button-labels", "deny");
      await asked;
    }
  });
}

describe("a prompt without a time limit", () => {
  test("stays until the user answers, and says nothing of a time limit", async () => {
    const { timeoutMs: _, ...request } = prompt("untimed");
    let answer: string | undefined;
    const asked = askCliConsent(request).then((a) => {
      answer = a;
      return a;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(answer).toBeUndefined();
      const html = renderToStaticMarkup(createElement(CliConsentDialogRoot));
      expect(html).not.toContain("turned down");
      expect(html).not.toContain("seconds");
    } finally {
      settleCliConsent("untimed", "once");
    }
    expect(await asked).toBe("once");
  });

  test("a timed one, from a computer that does not wait longer, is turned down after it", async () => {
    const answer = await askCliConsent({ ...prompt("timed"), timeoutMs: 5 });
    expect(answer).toBe("timeout");
  });
});

describe("settling a consent prompt from another device", () => {
  test("the prompt resolves to that answer, and a toast names the device", async () => {
    const toasts: ToastInput[] = [];
    const stop = watchToasts((t) => toasts.push(t));
    try {
      const first = askCliConsent(prompt("c1"));
      const second = askCliConsent(prompt("c2"));
      // One waiting its turn is settled too.
      expect(settleCliConsent("c2", "deny", "iPhone")).toBe(true);
      expect(await second).toBe("deny");
      expect(settleCliConsent("c1", "session", "iPhone")).toBe(true);
      expect(await first).toBe("session");
      expect(toasts).toHaveLength(2);
      expect(toasts.map((t) => t.kind)).toEqual(["info", "info"]);
    } finally {
      stop();
    }
  });

  test("the approval toast uses the choices offered by the answered prompt", async () => {
    const toasts: ToastInput[] = [];
    const stop = watchToasts((t) => toasts.push(t));
    const request = prompt("each-time");
    const regular = askCliConsent(prompt("regular"));
    const eachTime = askCliConsent({ ...request, change: { ...request.change, eachTime: true } });
    try {
      expect(settleCliConsent("each-time", "once", "iPhone")).toBe(true);
      expect(settleCliConsent("regular", "once", "iPhone")).toBe(true);
      expect(await Promise.all([eachTime, regular])).toEqual(["once", "once"]);
      expect(toasts.map((t) => t.message)).toEqual([
        "Allowed on iPhone.",
        "Allowed once on iPhone.",
      ]);
    } finally {
      settleCliConsent("each-time", "deny");
      settleCliConsent("regular", "deny");
      stop();
    }
  });

  test("one no longer waiting is not settled, and tells no one", async () => {
    const toasts: ToastInput[] = [];
    const stop = watchToasts((t) => toasts.push(t));
    try {
      const asked = askCliConsent(prompt("c3"));
      expect(settleCliConsent("c3", "once")).toBe(true);
      expect(await asked).toBe("once");
      expect(settleCliConsent("c3", "deny", "iPhone")).toBe(false);
      expect(settleCliConsent("gone", "once", "iPhone")).toBe(false);
      // Settled without a device's name: no toast.
      expect(toasts).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("who a consent prompt says asks", () => {
  const t = i18next.getFixedT("en", "settings");

  test("a terminal is told as one", () => {
    expect(describeConsent(t, prompt(), "send")).toBe(
      'The terminal "zsh" in app asks to send in api.',
    );
  });

  test("a Claude or Codex tab is told as that agent's tab, not a terminal", () => {
    expect(
      describeConsent(t, { ...prompt(), fromTab: "Review", fromAgent: "claude" }, "send"),
    ).toBe('The Claude tab "Review" in app asks to send in api.');
    expect(describeConsent(t, { ...prompt(), fromAgent: "codex" }, "send")).toContain(
      "The Codex tab",
    );
  });

  test("another computer's agent is told by that computer", () => {
    expect(
      describeConsent(t, { ...prompt(), fromDevice: "Mac", fromAgent: "claude" }, "send"),
    ).toBe('"zsh" on the computer Mac asks to send in api.');
  });
});

test("instruction edits and profile additions use the same Korean sentence as other approvals", () => {
  const t = i18next.getFixedT("ko", "settings");
  const change = {
    kind: "instructionsEdit",
    instructionEdit: { layer: { kind: "all" }, clear: true },
  } as const;
  const { detail, body } = consentDetailsOf(t, change);
  const edit = t("agentCli.consent.action.instructionsEdit", { detail });
  const add = t("agentCli.consent.action.profileAdd", { detail: "QA Codex" });
  expect(describeConsent(t, prompt(), edit, consentNamesTarget(change.kind))).toBe(
    'app의 터미널 "zsh"이(가) 모든 에이전트 지시 바꾸기를 하려고 합니다.',
  );
  expect(describeConsent(t, prompt(), add, consentNamesTarget("profileAdd"))).toBe(
    'app의 터미널 "zsh"이(가) 에이전트 프로필 "QA Codex" 추가를 하려고 합니다.',
  );
  expect(body).toBe("지시 비우기");
});

test("profile additions use settings connection labels in the dialog language", () => {
  const change = {
    kind: "profileAdd",
    detail: "Gateway",
    profileAdd: {
      agent: "codex",
      folder: "/tmp/gateway",
      connection: "custom",
      endpoint: "https://gateway.example",
    },
  } as const;
  expect(consentDetailsOf(i18next.getFixedT("en", "settings"), change).body).toBe(
    "Agent Codex\nFolder /tmp/gateway\nConnection Custom API address · https://gateway.example",
  );
  expect(consentDetailsOf(i18next.getFixedT("ko", "settings"), change).body).toBe(
    "에이전트 Codex\n폴더 /tmp/gateway\n연결 사용자 지정 API 주소 · https://gateway.example",
  );
});

test("sandbox approval shows localized copy and accepts an until-restart answer", async () => {
  const request = {
    ...prompt("sandbox"),
    change: { kind: "sandboxExecution", body: "make test" },
  } as const;
  const asked = askCliConsent(request);
  expect(settleCliConsent("sandbox", "session", "iPhone")).toBe(true);
  expect(await asked).toBe("session");
  const title = consentTitleOf(request.change.kind, false);
  const en = i18next.getFixedT("en", "settings");
  expect(en(title)).toBe("Let an agent run a command outside its sandbox?");
  const ko = i18next.getFixedT("ko", "settings");
  expect(ko(title)).toBe("에이전트가 샌드박스 밖에서 명령을 실행하도록 허용할까요?");
  expect(describeConsent(ko, request, "", false, true)).toBe(
    'app 워크스페이스의 "zsh" 탭이 api 워크스페이스에서 실행하려는 명령을 확인하세요.',
  );
  const sameWorkspace = { ...request, toWorkspace: "app", sameWorkspace: true };
  expect(describeConsent(ko, sameWorkspace, "", false, true)).toBe(
    'app 워크스페이스의 "zsh" 탭이 실행하려는 명령을 확인하세요.',
  );
  expect(describeConsent(en, sameWorkspace, "", false, true)).toBe(
    'Review the command requested by "zsh" in app.',
  );
});

test("sandbox approval for a one-time change can only be allowed once", async () => {
  const asked = askCliConsent({
    ...prompt("sandbox-once"),
    change: { kind: "sandboxExecution", eachTime: true },
  });
  expect(settleCliConsent("sandbox-once", "session", "iPhone")).toBe(false);
  expect(settleCliConsent("sandbox-once", "once", "iPhone")).toBe(true);
  expect(await asked).toBe("once");
});
