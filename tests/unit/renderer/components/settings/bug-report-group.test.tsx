import { afterEach, describe, expect, spyOn, test } from "bun:test";
import i18next from "i18next";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import type { BugReportContext } from "../../../../../packages/remote-protocol/src";
import * as toast from "../../../../../src/renderer/components/ui/toast";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { ipcOk } from "../../../../../src/shared/ipc/result";
import type { RemoteAccountState } from "../../../../../src/shared/remote/account";

const { BugReportFields, BugReportSection } = await import(
  "../../../../../src/renderer/components/settings/panels/bug-report-group"
);
const { bugReportFailureMessage, draftAsShown, sendBugReport } = await import(
  "../../../../../src/renderer/services/remote/bug-report"
);

const server = "http://localhost:8787";
const owner = JSON.stringify([server, "u1"]);
const signedIn: RemoteAccountState = {
  status: "signed-in",
  server,
  user: { id: "u1", email: "someone@example.com", name: "Someone" },
  device: { id: "d1", name: "Test Mac", platform: "darwin" },
};
const CONTEXT: BugReportContext = {
  app: { version: "1.4.0" },
  os: { version: "macOS-26.1" },
  device: { kind: "desktop", arch: "arm64" },
  protocol: { version: 2, package: "0.35.0" },
  locale: "en",
  errors: [
    { ago: 42, area: "api", code: "http_500", status: 500 },
    { ago: 7, area: "relay", code: "socket-closed" },
  ],
};

async function renderIn(language: string, node: ReactElement): Promise<string> {
  const i18n = i18next.cloneInstance({ lng: language });
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

const noop = () => {};
function form(overrides: Partial<Parameters<typeof BugReportFields>[0]> = {}): ReactElement {
  return (
    <BugReportFields
      email="someone@example.com"
      description=""
      contactOk={false}
      includeErrors
      open={false}
      context={null}
      sending={false}
      onDescription={noop}
      onContactOk={noop}
      onIncludeErrors={noop}
      onToggle={noop}
      onSend={noop}
      {...overrides}
    />
  );
}

const fields = (overrides: Partial<Parameters<typeof BugReportFields>[0]> = {}) =>
  renderToStaticMarkup(form(overrides));

const switches = (html: string) =>
  Array.from(html.matchAll(/role="switch" aria-checked="(true|false)"/g), (m) => m[1]);

describe("the bug report in About", () => {
  test("signed out, links the support page and has no form", async () => {
    const signedOut = { status: "signed-out", server } as const;
    const html = renderToStaticMarkup(<BugReportSection account={signedOut} />);
    expect(html).toContain(">Report a bug<");
    const link = html.match(/<a [^>]*data-testid="bug-report-support"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="https://nexuscode.gradiendo.com/en/support/"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("bug-report-send");
    const ko = await renderIn("ko", <BugReportSection account={signedOut} />);
    expect(ko).toContain('href="https://nexuscode.gradiendo.com/support/"');
    expect(ko).toContain(">버그 신고<");
    expect(html).toContain("Report on the support page");
    expect(ko).toContain("지원 페이지에서 신고");
    expect(html).not.toContain("Sign in to report");
    expect(html).not.toMatch(/<p[ >]/);
    expect(ko).not.toContain("로그인");
  });

  test("before the sign-in state is known, shows the title and neither the link nor the form", () => {
    const html = renderToStaticMarkup(<BugReportSection account={null} />);
    expect(html).toContain(">Report a bug<");
    expect(html).toContain('data-testid="bug-report-pending"');
    expect(html).not.toContain("bug-report-support");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Sign in to report");
  });

  test("signed in, a form with errors on and the email reply off by default", () => {
    const html = renderToStaticMarkup(<BugReportSection account={signedIn} />);
    expect(html).toContain("<textarea");
    expect(html).toContain("No conversations, file contents or log files are sent");
    expect(html).toContain("Include recent errors");
    expect(html).toContain(
      "Error messages with paths and keys hidden · Cleared when the app quits",
    );
    expect(html).not.toContain("no messages");
    expect(html).toContain("Reply by email");
    expect(html).toContain("someone@example.com");
    expect(switches(html)).toEqual(["true", "false"]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="bug-report-preview"');
    expect(html).not.toContain("bug-report-support");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="bug-report-send"/);
  });

  test("sends once the description has 10 characters after cleaning", () => {
    expect(fields({ description: "too short\r\n" })).toContain("At least 10 characters");
    const ready = fields({ description: "long enough\r\n" });
    expect(ready).toContain("11 / 3000");
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="bug-report-send"/);
    expect(fields({ description: "long enough", sending: true })).toContain("Sending…");
  });

  test("offers to discard the edited draft in both languages", async () => {
    expect(fields({ description: "qa-draft", onDiscard: noop })).toContain(">Discard draft<");
    const ko = await renderIn("ko", form({ description: "qa-draft", onDiscard: noop }));
    expect(ko).toContain(">초안 삭제<");
    expect(fields()).not.toContain("bug-report-discard");
  });

  test("shows what is sent, with its real values and one line per error", () => {
    const html = fields({ open: true, context: CONTEXT });
    expect(html).toContain('aria-expanded="true"');
    const preview = html.slice(html.indexOf('data-testid="bug-report-preview"'));
    for (const value of [
      "App version",
      "1.4.0",
      "OS version",
      '<code class="font-mono">macOS-26.1</code>',
      'Desktop · <code class="font-mono">arm64</code>',
      '<code class="font-mono">2</code> · <code class="font-mono">0.35.0</code>',
      "Language",
      ">English<",
    ]) {
      expect(preview).toContain(value);
    }
    const lines = Array.from(preview.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g), (m) =>
      m[1]?.replace(/<[^>]+>/g, ""),
    );
    expect(lines).toEqual(["api http_500 · 42 seconds ago", "relay socket-closed · 7 seconds ago"]);
    expect(preview).toContain('<code class="font-mono">api http_500</code> · 42 seconds ago');
  });

  test("an error line keeps a status that its code does not already show", () => {
    const context: BugReportContext = {
      ...CONTEXT,
      errors: [{ ago: 5, area: "rpc", code: "timeout", status: 504 }],
    };
    expect(fields({ open: true, context })).toContain(
      '<code class="font-mono">rpc timeout 504</code> · 5 seconds ago',
    );
  });

  test("shows each error's message exactly as it is sent, and how often it came", async () => {
    const context: BugReportContext = {
      ...CONTEXT,
      errors: [
        {
          ago: 3,
          area: "files",
          code: "write_file:permission_denied",
          message: "EACCES: permission denied, open '<path>'",
          count: 4,
        },
        { ago: 9, area: "agent", code: "claude:transient", status: 529 },
      ],
    };
    const html = fields({ open: true, context });
    const lines = Array.from(html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g), (m) =>
      m[1]?.replace(/<[^>]+>/g, ""),
    );
    expect(lines).toEqual([
      "files write_file:permission_denied · 4 times · 3 seconds agoEACCES: permission denied, open &#x27;&lt;path&gt;&#x27;",
      "agent claude:transient 529 · 9 seconds ago",
    ]);
    expect(html).toContain(
      '<div class="text-muted-foreground" data-testid="bug-report-error-message"><code class="font-mono">EACCES: permission denied, open &#x27;&lt;path&gt;&#x27;</code></div>',
    );
    const ko = await renderIn("ko", form({ open: true, context }));
    expect(ko).toContain("4회");
    expect(ko).toContain("경로와 키를 가린 오류 메시지 · 앱을 끄면 지워짐");
    const off = fields({ open: true, includeErrors: false, context });
    expect(off).toContain("Not included");
    expect(off).not.toContain("EACCES");
    expect(off).not.toContain("bug-report-error-message");
  });

  test("with errors off, the preview says they are not included", () => {
    const { errors: _, ...withoutErrors } = CONTEXT;
    const html = fields({ open: true, includeErrors: false, context: withoutErrors });
    expect(switches(html)).toEqual(["false", "false"]);
    expect(html).toContain("Not included");
    expect(html).not.toContain("<li");
    expect(fields({ open: true, context: { ...CONTEXT, errors: [] } })).toContain(">None<");
  });

  test("the Korean preview counts seconds in Korean", async () => {
    const html = await renderIn("ko", form({ open: true, context: CONTEXT }));
    expect(html).toContain("함께 보내는 정보");
    expect(html).toContain('<code class="font-mono">api http_500</code> · 42초 전');
    expect(html).toContain("데스크톱");
    expect(html).toContain("OS 버전");
  });

  test.each([
    [0, "0 seconds ago", "0초 전"],
    [1, "1 second ago", "1초 전"],
    [59, "59 seconds ago", "59초 전"],
    [60, "1 minute ago", "1분 전"],
    [3000, "50 minutes ago", "50분 전"],
    [3599, "59 minutes ago", "59분 전"],
    [3600, "1 hour ago", "1시간 전"],
    [7300, "2 hours ago", "2시간 전"],
    [2_592_000, "720 hours ago", "720시간 전"],
  ])("an error %i s ago reads %s", async (ago, en, ko) => {
    const context = { ...CONTEXT, errors: [{ ago, area: "api", code: "offline" }] } as const;
    const line = (html: string) =>
      html.match(/<li[^>]*>([\s\S]*?)<\/li>/)?.[1]?.replace(/<[^>]+>/g, "");
    expect(line(fields({ open: true, context }))).toBe(`api offline · ${en}`);
    expect(line(await renderIn("ko", form({ open: true, context })))).toBe(`api offline · ${ko}`);
  });
});

describe("what the form sends", () => {
  const draft = {
    description: "Long enough text",
    contactOk: false,
    includeErrors: true,
    locale: "en",
  } as const;
  const shown = {
    at: 5_000,
    context: {
      app: { version: "1.4.0" },
      os: { version: "macOS-26.1" },
      device: { kind: "desktop" as const },
      protocol: { version: 2, package: "0.36.1" },
      locale: "en" as const,
      errors: [{ ago: 3, area: "api" as const, code: "offline", message: "shown" }],
    },
  };

  test("is the error list the preview showed, with when it was shown", () => {
    expect(draftAsShown(draft, shown)).toEqual({
      ...draft,
      shown: { at: 5_000, errors: [{ ago: 3, area: "api", code: "offline", message: "shown" }] },
    });
  });

  test("carries no errors when they are off or nothing was shown yet", () => {
    expect(draftAsShown({ ...draft, includeErrors: false }, shown)).toEqual({
      ...draft,
      includeErrors: false,
    });
    expect(draftAsShown(draft, null)).toEqual(draft);
    expect(
      draftAsShown(draft, { ...shown, context: { ...shown.context, errors: undefined } }),
    ).toEqual(draft);
  });
});

describe("sending from the form", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("confirms a sent report", async () => {
    const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(
      ipcOk({ status: "sent", id: "r1" }) as never,
    );
    const shown = spyOn(toast, "showToast").mockReturnValue(1);
    spies.push(call, shown);
    const draft = {
      description: "Long enough text",
      contactOk: true,
      includeErrors: false,
      locale: "en",
    } as const;
    expect(await sendBugReport(owner, draft)).toBe(true);
    expect(call).toHaveBeenCalledWith("remote", "sendBugReport", { ...draft, owner });
    expect(shown).toHaveBeenCalledWith({ kind: "info", message: "Report sent. Thank you." });
  });

  test("says why a report did not go", async () => {
    const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(
      ipcOk({ status: "failed", failure: "rate-limited", retryAfter: 90 }) as never,
    );
    const shown = spyOn(toast, "showToast").mockReturnValue(1);
    spies.push(call, shown);
    const draft = {
      description: "Long enough text",
      contactOk: false,
      includeErrors: true,
      locale: "en",
    } as const;
    expect(await sendBugReport(owner, draft)).toBe(false);
    expect(shown).toHaveBeenCalledWith({
      kind: "error",
      message: "Too many reports. Try again in 2 minutes.",
    });
  });

  test.each([
    ["rate-limited", undefined, "Too many reports. Try again later."],
    ["rate-limited", 30, "Too many reports. Try again in 1 minute."],
    ["rate-limited", 3600, "Too many reports. Try again in 1 hour."],
    ["rate-limited", 20 * 3600 + 1, "Too many reports. Try again in 21 hours."],
    ["signed-out", undefined, "You were signed out. Sign in again."],
    [
      "not-allowed",
      undefined,
      "This account can't send reports. Contact us through the support page.",
    ],
    ["too-big", undefined, "The report is too long. Shorten it and try again."],
    [
      "unsupported",
      undefined,
      "The server doesn't take reports yet. Use the support page for now.",
    ],
    ["offline", undefined, "Can't reach the server. Try again shortly."],
    ["failed", undefined, "Couldn't send the report. Try again."],
  ] as const)("%s (Retry-After %p): %s", (failure, retryAfter, message) => {
    expect(bugReportFailureMessage(failure, retryAfter)).toBe(message);
  });

  test("the Korean messages end as the app's other errors do", async () => {
    await i18next.changeLanguage("ko");
    try {
      expect(bugReportFailureMessage("rate-limited", 600)).toBe(
        "신고를 너무 많이 보냈습니다. 10분 후 다시 시도하세요.",
      );
      expect(bugReportFailureMessage("offline")).toBe(
        "서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.",
      );
    } finally {
      await i18next.changeLanguage("en");
    }
  });
});
