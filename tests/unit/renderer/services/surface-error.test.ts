/**
 * Scenario-based unit tests for the surfaceError routing module.
 *
 * Tests verify observable routing behaviour — which surface the function
 * returns and what it shows — not implementation internals. Each scenario
 * names the category + requested surface so failures are immediately legible.
 *
 * The tests mock:
 *   - showToast (toast system)  — captures calls without React rendering
 *   - createLogger (log facade) — captures log calls without IPC relay
 *   - copyText (clipboard)      — captures copy calls without browser API
 *   - electron-log/renderer     — the dynamic import used by openLogFile
 *   - ipc/client                — the dynamic import used by openLogFile
 *
 * No React, no DOM, no IPC bridge required.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import i18next from "i18next";
import type { ToastAction, ToastInput } from "../../../../src/renderer/components/ui/toast";
import {
  appErrorBug,
  appErrorCancelled,
  appErrorFailed,
  appErrorInvalidInput,
} from "../../../../src/shared/error/app-error";
import { createI18n } from "../../../../src/shared/i18n/index";

// ---------------------------------------------------------------------------
// i18next initialisation — surface-error.ts calls i18next.t() at invocation
// time. The global singleton must be initialised before the SUT is loaded so
// that t() returns real translation strings rather than undefined.
// ---------------------------------------------------------------------------

const { options: i18nOptions } = createI18n({ lng: "en" });
// i18next.init is async but resolves instantly because resources are bundled.
// The top-level await keeps the test file in sync with the module evaluation.
await i18next.init(i18nOptions);

// ---------------------------------------------------------------------------
// Toast mock — captures showToast calls
// ---------------------------------------------------------------------------

const toastCalls: ToastInput[] = [];

mock.module("../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: ToastInput) => {
    toastCalls.push(input);
  },
}));

// ---------------------------------------------------------------------------
// Clipboard mock — captures copyText calls
// ---------------------------------------------------------------------------

const clipboardCalls: string[] = [];

mock.module("../../../../src/renderer/utils/clipboard", () => ({
  copyText: (text: string) => {
    clipboardCalls.push(text);
  },
}));

// ---------------------------------------------------------------------------
// Logger spies — captures log calls by level
//
// surface-error.ts creates its logger when it loads, which may be in an earlier
// test file, so a mock.module of the log facade here would miss that logger.
// The log facade spies (tests/log-test-spies.ts) see every logger instead.
// ---------------------------------------------------------------------------

interface LogCall {
  level: "error" | "warn" | "info" | "debug";
  msg: string;
}

const logCalls: LogCall[] = [];

const { rendererErrorMock, rendererWarnMock, rendererInfoMock, rendererDebugMock } = await import(
  "../../../log-test-spies"
);
const levelSpies = [
  ["error", rendererErrorMock],
  ["warn", rendererWarnMock],
  ["info", rendererInfoMock],
  ["debug", rendererDebugMock],
] as const;
for (const [level, spy] of levelSpies) {
  spy.mockImplementation((msg: string) => {
    logCalls.push({ level, msg });
  });
}
afterAll(() => {
  for (const [, spy] of levelSpies) spy.mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// SUT import (after mocks are installed so the module sees mocked deps)
// ---------------------------------------------------------------------------

const { surfaceError } = await import(
  "../../../../src/renderer/services/error-surface/surface-error"
);

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

function reset(): void {
  toastCalls.length = 0;
  clipboardCalls.length = 0;
  logCalls.length = 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toastActionLabels(): string[][] {
  return toastCalls.map((t) => (t.actions ?? []).map((a: ToastAction) => a.label));
}

// ---------------------------------------------------------------------------
// cancelled — always silent
// ---------------------------------------------------------------------------

describe("cancelled", () => {
  beforeEach(reset);

  test("returns silent surface, shows nothing, logs nothing", () => {
    const err = appErrorCancelled("aborted by signal");
    const result = surfaceError(err, { surface: "toast" });

    expect(result.surface).toBe("silent");
    expect(toastCalls).toHaveLength(0);
    expect(logCalls).toHaveLength(0);
  });

  test("cancelled is silent even when surface=auto", () => {
    const err = appErrorCancelled("signal");
    const result = surfaceError(err, { surface: "auto" });

    expect(result.surface).toBe("silent");
    expect(toastCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// invalid-input — inline only
// ---------------------------------------------------------------------------

describe("invalid-input", () => {
  beforeEach(reset);

  test("surface=inline returns inline with a user message", () => {
    const err = appErrorInvalidInput("branch name contains spaces");
    const result = surfaceError(err, { surface: "inline" });

    expect(result.surface).toBe("inline");
    if (result.surface !== "inline") throw new Error("narrowing");
    // userMessage must be short and friendly — never expose the internal message
    expect(result.userMessage).toBeTruthy();
    expect(result.userMessage).not.toContain("branch name contains spaces");
    expect(toastCalls).toHaveLength(0);
  });

  test("surface=toast is refused and demoted to inline with a warn log", () => {
    const err = appErrorInvalidInput("empty name");
    const result = surfaceError(err, { surface: "toast" });

    expect(result.surface).toBe("inline");
    expect(toastCalls).toHaveLength(0);
    const warnLogs = logCalls.filter((l) => l.level === "warn");
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0].msg).toContain("invalid-input");
    expect(warnLogs[0].msg).toContain("toast");
  });

  test("surface=banner is refused and demoted to inline with a warn log", () => {
    const err = appErrorInvalidInput("bad input");
    const result = surfaceError(err, { surface: "banner" });

    expect(result.surface).toBe("inline");
    expect(toastCalls).toHaveLength(0);
    expect(logCalls.some((l) => l.level === "warn" && l.msg.includes("banner"))).toBe(true);
  });

  test("fs code NOT_FOUND renders a friendly user message without exposing the path", () => {
    const err = appErrorInvalidInput("NOT_FOUND: /home/user/.secret/config", {
      domain: "fs",
      code: "NOT_FOUND",
    });
    const result = surfaceError(err, { surface: "inline" });

    if (result.surface !== "inline") throw new Error("narrowing");
    expect(result.userMessage).not.toContain("/home/user/.secret");
    expect(result.userMessage).not.toContain("NOT_FOUND:");
    expect(result.userMessage.length).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// failed — inline, banner, or toast fallback
// ---------------------------------------------------------------------------

describe("failed", () => {
  beforeEach(reset);

  test("surface=inline returns inline with a user message, logs at warn", () => {
    const err = appErrorFailed("NOT_FOUND: /repo/file.ts", { domain: "fs", code: "NOT_FOUND" });
    const result = surfaceError(err, { surface: "inline" });

    expect(result.surface).toBe("inline");
    if (result.surface !== "inline") throw new Error("narrowing");
    expect(result.userMessage).not.toContain("/repo/file.ts");
    expect(logCalls.some((l) => l.level === "warn")).toBe(true);
    expect(toastCalls).toHaveLength(0);
  });

  test("surface=banner returns banner with userMessage and optional onRetry", () => {
    const retryFn = mock(() => {});
    const err = appErrorFailed("upstream gone", { domain: "git", code: "no-upstream" });
    const result = surfaceError(err, { surface: "banner", onRetry: retryFn });

    expect(result.surface).toBe("banner");
    if (result.surface !== "banner") throw new Error("narrowing");
    expect(result.userMessage).toBeTruthy();
    expect(result.onRetry).toBe(retryFn);
    expect(toastCalls).toHaveLength(0);
  });

  test("surface=banner without onRetry has no retry in result", () => {
    const err = appErrorFailed("not found");
    const result = surfaceError(err, { surface: "banner" });

    if (result.surface !== "banner") throw new Error("narrowing");
    expect(result.onRetry).toBeUndefined();
  });

  test("surface=toast shows one toast with friendly message, no raw path", () => {
    const err = appErrorFailed("PERMISSION_DENIED: /etc/shadow", {
      domain: "fs",
      code: "PERMISSION_DENIED",
    });
    surfaceError(err, { surface: "toast" });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].message).not.toContain("/etc/shadow");
    expect(toastCalls[0].message).not.toContain("PERMISSION_DENIED:");
  });

  test("surface=auto falls back to toast", () => {
    const err = appErrorFailed("failed save");
    surfaceError(err, { surface: "auto" });

    expect(toastCalls).toHaveLength(1);
  });

  test("surface=toast with onRetry shows Retry action button on toast", () => {
    const retryFn = mock(() => {});
    const err = appErrorFailed("save failed");
    surfaceError(err, { surface: "toast", onRetry: retryFn });

    expect(toastCalls).toHaveLength(1);
    const labels = toastActionLabels()[0];
    expect(labels).toContain("Retry");
  });

  test("surface=toast without onRetry shows no actions (plain toast)", () => {
    const err = appErrorFailed("save failed");
    surfaceError(err, { surface: "toast" });

    expect(toastCalls).toHaveLength(1);
    const actions = toastCalls[0].actions ?? [];
    expect(actions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// bug — toast only, with action buttons
// ---------------------------------------------------------------------------

describe("bug", () => {
  beforeEach(reset);

  test("shows exactly one toast with generic user message", () => {
    const err = appErrorBug("Unexpected null workspace at line 42 of store.ts");
    surfaceError(err, { surface: "auto" });

    expect(toastCalls).toHaveLength(1);
    // Generic user message — never contains stack fragment or internal text
    expect(toastCalls[0].message).not.toContain("line 42");
    expect(toastCalls[0].message).not.toContain("store.ts");
    expect(toastCalls[0].message).not.toContain("Unexpected null workspace");
  });

  test("toast has 'Copy details' and 'Open log' action buttons", () => {
    const err = appErrorBug("invariant violated");
    surfaceError(err, { surface: "auto" });

    expect(toastCalls).toHaveLength(1);
    const labels = toastActionLabels()[0];
    expect(labels).toContain("Copy details");
    expect(labels).toContain("Open log");
  });

  test("'Copy details' action writes internal context to clipboard, not to UI", () => {
    const err = appErrorBug("crash: stack overflow in recursive call", {
      correlationId: "req-99",
      domain: "git",
      code: "stack-overflow",
    });
    surfaceError(err, { surface: "auto" });

    const copyAction = (toastCalls[0].actions ?? []).find(
      (a: ToastAction) => a.label === "Copy details",
    );
    expect(copyAction).toBeDefined();

    // Invoke the action — this writes to clipboard (mocked)
    copyAction?.onAction();

    expect(clipboardCalls).toHaveLength(1);
    // The clipboard text must contain internal detail, not the user-facing message
    expect(clipboardCalls[0]).toContain("req-99");
    expect(clipboardCalls[0]).toContain("stack overflow in recursive call");
    // The clipboard text must NOT be rendered in the toast message
    expect(toastCalls[0].message).not.toContain(clipboardCalls[0]);
  });

  test("logs at error level with internal message, not user message", () => {
    const internalMsg = "invariant: tab id not in layout tree";
    const err = appErrorBug(internalMsg, { correlationId: "req-123" });
    surfaceError(err, { surface: "auto" });

    const errorLogs = logCalls.filter((l) => l.level === "error");
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].msg).toContain(internalMsg);
    // User-facing generic message must NOT be logged (it's trivial, not informative)
    expect(errorLogs[0].msg).not.toBe(toastCalls[0].message);
  });

  test("surface=inline is demoted to toast with a warn log", () => {
    const err = appErrorBug("internal error");
    const result = surfaceError(err, { surface: "inline" });

    expect(result.surface).toBe("toast");
    expect(toastCalls).toHaveLength(1);
    expect(logCalls.some((l) => l.level === "warn" && l.msg.includes("inline"))).toBe(true);
  });

  test("surface=banner is demoted to toast with a warn log", () => {
    const err = appErrorBug("internal error");
    const result = surfaceError(err, { surface: "banner" });

    expect(result.surface).toBe("toast");
    expect(toastCalls).toHaveLength(1);
    expect(logCalls.some((l) => l.level === "warn" && l.msg.includes("banner"))).toBe(true);
  });

  test("surface=toast shows toast (explicit request accepted)", () => {
    const err = appErrorBug("crash");
    const result = surfaceError(err, { surface: "toast" });

    expect(result.surface).toBe("toast");
    expect(toastCalls).toHaveLength(1);
  });
});
