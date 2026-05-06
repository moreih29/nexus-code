import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LspServerEvent } from "../../../../src/shared/lsp-types";
import {
  disposeLspServerUxRouter,
  getWorkDoneProgressState,
  routeLspServerEvent,
} from "../../../../src/renderer/services/lsp/server-ux-router";

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
  });

  afterEach(() => {
    disposeLspServerUxRouter();
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
  });

  test("routes window/logMessage severity 1/2/3/4 to console error/warn/info/log", () => {
    routeLspServerEvent(serverEvent("window/logMessage", { type: 1, message: "error" }));
    routeLspServerEvent(serverEvent("window/logMessage", { type: 2, message: "warning" }));
    routeLspServerEvent(serverEvent("window/logMessage", { type: 3, message: "info" }));
    routeLspServerEvent(serverEvent("window/logMessage", { type: 4, message: "log" }));

    expect(console.error).toHaveBeenCalledWith("[lsp:typescript:ws-1] error");
    expect(console.warn).toHaveBeenCalledWith("[lsp:typescript:ws-1] warning");
    expect(console.info).toHaveBeenCalledWith("[lsp:typescript:ws-1] info");
    expect(console.log).toHaveBeenCalledWith("[lsp:typescript:ws-1] log");
  });

  test("routes window/showMessage through the same severity logging stub", () => {
    routeLspServerEvent(serverEvent("window/showMessage", { type: 2, message: "Heads up" }));

    expect(console.warn).toHaveBeenCalledWith("[lsp:typescript:ws-1] Heads up");
  });

  test("registers window/workDoneProgress/create tokens", () => {
    routeLspServerEvent(
      serverEvent("window/workDoneProgress/create", { token: "progress-token" }),
    );

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
