import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  disposeLspServerUxRouter,
  getWorkDoneProgressState,
  routeLspServerEvent,
} from "../../../../src/renderer/services/lsp-ux/server-ux-router";
import type { LspServerEvent } from "../../../../src/shared/lsp";

// Spy imported from the preload — the log-test-spies.ts preload wraps
// src/shared/log/renderer's createLogger so that every call to log.warn()
// inside server-ux-router.ts increments rendererWarnMock.
import { rendererWarnMock } from "../../../../tests/log-test-spies";

const originalConsole = {
  error: console.error,
  warn: console.warn,
  info: console.info,
  log: console.log,
};

function serverEvent(method: LspServerEvent["method"], params: unknown): LspServerEvent {
  return {
    workspaceId: "ws-1",
    languageId: "typescript",
    method,
    params,
  };
}

describe("LSP server UX router", () => {
  beforeEach(() => {
    console.error = mock(() => {}) as unknown as typeof console.error;
    console.warn = mock(() => {}) as unknown as typeof console.warn;
    console.info = mock(() => {}) as unknown as typeof console.info;
    console.log = mock(() => {}) as unknown as typeof console.log;
    rendererWarnMock.mockClear();
  });

  afterEach(() => {
    disposeLspServerUxRouter();
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
  });

  test("drops window/logMessage so the debug channel does not flood devtools", () => {
    // `window/logMessage` is the LSP spec's debug channel. Servers like
    // tsserver emit info/log entries on every analysis cycle, so routing
    // them to the console would make devtools unusable. Verify all four
    // severity levels are silently dropped.
    routeLspServerEvent(serverEvent("window/logMessage", { type: 1, message: "error" }));
    routeLspServerEvent(serverEvent("window/logMessage", { type: 2, message: "warning" }));
    routeLspServerEvent(serverEvent("window/logMessage", { type: 3, message: "info" }));
    routeLspServerEvent(serverEvent("window/logMessage", { type: 4, message: "log" }));

    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  test("routes window/showMessage through the severity logging stub", () => {
    // The user-facing channel is surfaced via the logger facade. Type 2 is
    // MessageType.Warning, so the router calls log.warn with the prefixed message.
    // The preload-installed spy (rendererWarnMock) observes the call directly.
    routeLspServerEvent(serverEvent("window/showMessage", { type: 2, message: "Heads up" }));

    expect(rendererWarnMock).toHaveBeenCalledTimes(1);
    // The facade's Logger interface calls warn(msg, meta?) — the first positional
    // arg is the message string.
    expect(rendererWarnMock.mock.calls[0][0]).toBe("[lsp:typescript:ws-1] Heads up");
  });

  test("registers window/workDoneProgress/create tokens", () => {
    routeLspServerEvent(serverEvent("window/workDoneProgress/create", { token: "progress-token" }));

    expect(getWorkDoneProgressState("ws-1", "typescript", "progress-token")).toEqual({
      workspaceId: "ws-1",
      languageId: "typescript",
      token: "progress-token",
      phase: "create",
      done: false,
    });
  });

  test("tracks $/progress begin/report/end state for registered token", () => {
    routeLspServerEvent(serverEvent("window/workDoneProgress/create", { token: "build" }));
    routeLspServerEvent(
      serverEvent("$/progress", {
        token: "build",
        value: {
          kind: "begin",
          title: "Build",
          message: "Starting",
          percentage: 0,
          cancellable: true,
        },
      }),
    );
    routeLspServerEvent(
      serverEvent("$/progress", {
        token: "build",
        value: { kind: "report", message: "Halfway", percentage: 50 },
      }),
    );
    routeLspServerEvent(
      serverEvent("$/progress", {
        token: "build",
        value: { kind: "end", message: "Done" },
      }),
    );

    expect(getWorkDoneProgressState("ws-1", "typescript", "build")).toEqual({
      workspaceId: "ws-1",
      languageId: "typescript",
      token: "build",
      phase: "end",
      done: true,
      title: "Build",
      message: "Done",
      percentage: 50,
      cancellable: true,
    });
  });
});
