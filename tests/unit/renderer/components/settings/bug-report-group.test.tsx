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
const { bugReportFailureMessage, sendBugReport } = await import(
  "../../../../../src/renderer/services/remote/bug-report"
);

const server = "http://localhost:8787";
const signedIn: RemoteAccountState = {
  status: "signed-in",
  server,
  user: { id: "u1", email: "someone@example.com", name: "Someone" },
  device: { id: "d1", name: "Test Mac", platform: "darwin" },
};
const CONTEXT: BugReportContext = {
  app: { version: "1.4.0" },
  os: { version: "25.1.0" },
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
    for (const state of [null, { status: "signed-out", server } as const]) {
      const html = renderToStaticMarkup(<BugReportSection account={state} />);
      expect(html).toContain(">Report a bug<");
      const link = html.match(/<a [^>]*data-testid="bug-report-support"[^>]*>/)?.[0] ?? "";
      expect(link).toContain('href="https://nexuscode.gradiendo.com/en/support/"');
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain("bug-report-send");
    }
    const ko = await renderIn("ko", <BugReportSection account={null} />);
    expect(ko).toContain('href="https://nexuscode.gradiendo.com/support/"');
    expect(ko).toContain(">버그 신고<");
  });

  test("signed in, a form with errors on and the email reply off by default", () => {
    const html = renderToStaticMarkup(<BugReportSection account={signedIn} />);
    expect(html).toContain("<textarea");
    expect(html).toContain("No conversations, files or paths are sent");
    expect(html).toContain("Include recent errors");
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

  test("shows what is sent, with its real values and one line per error", () => {
    const html = fields({ open: true, context: CONTEXT });
    expect(html).toContain('aria-expanded="true"');
    const preview = html.slice(html.indexOf('data-testid="bug-report-preview"'));
    for (const value of [
      "App version",
      "1.4.0",
      "OS version",
      "25.1.0",
      "desktop · arm64",
      "2 · 0.35.0",
      "Language",
      ">en<",
    ]) {
      expect(preview).toContain(value);
    }
    const lines = Array.from(preview.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g), (m) => m[1]);
    expect(lines).toEqual(["api http_500 500 · 42 s ago", "relay socket-closed · 7 s ago"]);
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
    expect(html).toContain("api http_500 500 · 42초 전");
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
    expect(await sendBugReport(draft)).toBe(true);
    expect(call).toHaveBeenCalledWith("remote", "sendBugReport", draft);
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
    expect(await sendBugReport(draft)).toBe(false);
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
