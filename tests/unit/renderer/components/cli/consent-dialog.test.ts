/** A consent prompt answered on another device of the user's comes down here, saying so. */
import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import {
  askCliConsent,
  consentNamesTarget,
  consentTitleOf,
  describeConsent,
  settleCliConsent,
} from "../../../../../src/renderer/components/cli/consent-dialog";
import { type ToastInput, watchToasts } from "../../../../../src/renderer/components/ui/toast";
import { consentDetailsOf } from "../../../../../src/shared/cli/consent-copy";

const prompt = (id?: string) => ({
  ...(id ? { id } : {}),
  fromWorkspace: "app",
  fromTab: "zsh",
  toWorkspace: "api",
  change: { kind: "chatInput" as const, detail: "Review" },
  timeoutMs: 60_000,
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

test("sandbox approval shows localized copy and can only be allowed once", async () => {
  const request = {
    ...prompt("sandbox"),
    change: { kind: "sandboxExecution", eachTime: true, body: "make test" },
  } as const;
  const asked = askCliConsent(request);
  expect(settleCliConsent("sandbox", "session", "iPhone")).toBe(false);
  expect(settleCliConsent("sandbox", "once", "iPhone")).toBe(true);
  expect(await asked).toBe("once");
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
