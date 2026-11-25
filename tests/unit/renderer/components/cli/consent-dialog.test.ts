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

mock.module("../../../../../src/renderer/components/ui/dialog", () => ({
  Dialog: ({ open, children }: DialogProps) =>
    createElement(
      RadixDialog.Root,
      { open },
      createElement("section", { "data-open": String(open) }, children),
    ),
}));

const buttonLabels = (html: string) =>
  Array.from(html.matchAll(/<button[^>]*>([^<]*)<\/button>/g), ([, label]) => label);

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
      expect(buttonLabels(html)).toEqual(labels);
    } finally {
      settleCliConsent("button-labels", "deny");
      await asked;
    }
  });
}

test("an answered prompt keeps its own title and choices while the dialog closes", async () => {
  const asked = askCliConsent({
    ...prompt("closing"),
    change: { kind: "chatMode", detail: '"Review" (default → acceptEdits)', eachTime: true },
  });
  const open = renderToStaticMarkup(createElement(CliConsentDialogRoot));
  settleCliConsent("closing", "once");
  expect(await asked).toBe("once");
  const closing = renderToStaticMarkup(createElement(CliConsentDialogRoot));
  expect(open).toContain('data-open="true"');
  expect(closing).toContain('data-open="false"');
  expect(buttonLabels(closing)).toEqual(["Don&#x27;t allow", "Allow"]);
  expect(closing.replace('data-open="false"', 'data-open="true"')).toBe(open);
});

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
    'app의 터미널 "zsh": 모든 에이전트 지시 바꾸기를 하려고 합니다.',
  );
  expect(describeConsent(t, prompt(), add, consentNamesTarget("profileAdd"))).toBe(
    'app의 터미널 "zsh": 에이전트 프로필 "QA Codex" 추가를 하려고 합니다.',
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

test("profile edits list each change in the dialog language and name the profile", () => {
  const change = {
    kind: "profileEdit",
    detail: "Gateway",
    profileEdit: {
      agent: "claude",
      lines: [
        { field: "connection", from: "account", to: "custom" },
        { field: "models", value: "glm-5.3 → glm-5.4" },
        { field: "defaultModel", value: "glm-5.3 → glm-5.4" },
        { field: "context", value: "auto → 400000" },
        { field: "key", change: "replaced" },
      ],
    },
  } as const;
  expect(consentDetailsOf(i18next.getFixedT("en", "settings"), change).body).toBe(
    "Agent Claude\nConnection Claude account → Custom API address\nModels glm-5.3 → glm-5.4\n" +
      "Default model glm-5.3 → glm-5.4\nContext window auto → 400000\nAPI key replaced",
  );
  const ko = i18next.getFixedT("ko", "settings");
  expect(consentDetailsOf(ko, change).body).toBe(
    "에이전트 Claude\n연결 Claude 계정 → 사용자 지정 API 주소\n모델 glm-5.3 → glm-5.4\n" +
      "기본 모델 glm-5.3 → glm-5.4\n컨텍스트 창 auto → 400000\nAPI 키 바꿈",
  );
  const action = ko("agentCli.consent.action.profileEdit", { detail: "Gateway" });
  expect(describeConsent(ko, prompt(), action, consentNamesTarget("profileEdit"))).toBe(
    'app의 터미널 "zsh": 에이전트 프로필 "Gateway" 변경을 하려고 합니다.',
  );
  expect(ko(consentTitleOf("profileEdit", false))).toBe(
    "에이전트가 이 컴퓨터의 프로필을 바꾸도록 허용할까요?",
  );
});

test("profile removals name the agent and say the folder stays", () => {
  const change = {
    kind: "profileRemove",
    detail: "Gateway",
    profileRemove: { agent: "codex", folder: "~/.codex-gateway" },
  } as const;
  const ko = i18next.getFixedT("ko", "settings");
  expect(consentDetailsOf(ko, change).body).toBe(
    "에이전트 Codex\n폴더(~/.codex-gateway)와 그 안의 로그인·기록은 남습니다.",
  );
  expect(ko(consentTitleOf("profileRemove", false))).toBe(
    "에이전트가 이 컴퓨터의 프로필을 삭제하도록 허용할까요?",
  );
  expect(consentNamesTarget("profileRemove")).toBe(true);
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

test("turning a setting on names the setting and what it sends, in the dialog language", () => {
  const change = { kind: "settingTurnOn", detail: "notes.summary", eachTime: true } as const;
  const ko = i18next.getFixedT("ko", "settings");
  const { detail, body } = consentDetailsOf(ko, change);
  expect(
    describeConsent(
      ko,
      prompt(),
      ko("agentCli.consent.action.settingTurnOn", { detail }),
      consentNamesTarget(change.kind),
    ),
  ).toBe('app의 터미널 "zsh": "녹음 자동 요약" 켜기를 하려고 합니다.');
  expect(body).toBe("요약 시 녹취록을 요약 프로필의 모델로 전송 · NexusCode 서버 미경유");
  expect(consentTitleOf(change.kind, false)).toBe("agentCli.consent.setting_on_title");
  expect(
    consentDetailsOf(i18next.getFixedT("en", "settings"), {
      ...change,
      detail: "notes.voiceSuggest",
    }).detail,
  ).toBe("Suggest names from voices");
});

test("a setting's body reads as a sentence, not as a command", async () => {
  const asked = askCliConsent({
    ...prompt("setting-body"),
    change: { kind: "settingTurnOn", detail: "notes.summary", eachTime: true },
  });
  try {
    const html = renderToStaticMarkup(createElement(CliConsentDialogRoot));
    expect(html).not.toContain("<pre");
    expect(html).toContain("Not through NexusCode servers</p>");
  } finally {
    settleCliConsent("setting-body", "deny");
    await asked;
  }
});
