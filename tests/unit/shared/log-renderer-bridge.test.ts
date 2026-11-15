import { afterEach, describe, expect, mock, test } from "bun:test";
import { createLogger } from "../../../src/shared/log/renderer";

type Bridge = Record<"error" | "warn" | "info" | "debug", (...a: unknown[]) => void>;
const scope = globalThis as { window?: { __electronLog?: Bridge; addEventListener?: unknown } };

function withBridge(): Bridge {
  const bridge = { error: mock(), warn: mock(), info: mock(), debug: mock() };
  scope.window ??= { addEventListener: () => {} };
  scope.window.__electronLog = bridge;
  return bridge;
}

afterEach(() => {
  if (scope.window) delete scope.window.__electronLog;
});

describe("the renderer log facade", () => {
  test("sends through electron-log's bridge, as a bundled renderer has no require", () => {
    const bridge = withBridge();
    createLogger("csp").warn("blocked img-src");
    expect(bridge.warn).toHaveBeenCalledWith({ __nx_log: true, source: "csp" }, "blocked img-src");
    createLogger("renderer").error("boom", { correlationId: "c1" });
    expect(bridge.error).toHaveBeenCalledWith(
      { __nx_log: true, source: "renderer", correlationId: "c1" },
      "boom",
    );
  });

  test("passes over a bridge that lacks a level", () => {
    scope.window ??= { addEventListener: () => {} };
    const warn = mock();
    scope.window.__electronLog = { warn } as unknown as Bridge;
    const log = createLogger("csp");
    expect(() => log.warn("still logs")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
