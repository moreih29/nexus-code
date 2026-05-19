/**
 * Unit tests for src/main/error-safety-net.ts
 *
 * The handlers are pure in the sense that their only observable effects are
 * (a) calling the logger and (b) optionally calling process.exit.
 * We mock both so the tests remain hermetic.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock electron and electron-log/main before any transitive imports load them.
// Both are pulled in through src/shared/log/main which error-safety-net uses.
// mock.module() calls must appear before dynamic import() of the subject.
// ---------------------------------------------------------------------------

mock.module("electron", () => ({
  app: {
    getPath: mock((_name: string) => "/tmp/test-logs"),
  },
}));

const mockElectronLogError = mock((..._args: unknown[]) => {});

mock.module("electron-log/main", () => ({
  default: {
    error: mockElectronLogError,
    warn: mock((..._args: unknown[]) => {}),
    info: mock((..._args: unknown[]) => {}),
    debug: mock((..._args: unknown[]) => {}),
    transports: {
      file: {
        resolvePathFn: null,
        level: "debug",
        format: null,
      },
      console: { level: "info", format: null },
    },
    initialize: mock(() => {}),
    variables: {},
  },
}));

// ---------------------------------------------------------------------------
// Dynamic import ensures mock.module() registrations are applied first.
// ---------------------------------------------------------------------------

const {
  onUncaughtException,
  onUnhandledRejection,
  installErrorSafetyNet,
} = await import("../../../src/main/error-safety-net");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockElectronLogError.mockClear();
});

/**
 * Returns the message string passed to log.error().
 * electron-log receives (envelope, message) so we inspect the second argument.
 */
function lastErrorMsg(): string {
  const calls = mockElectronLogError.mock.calls;
  if (calls.length === 0) throw new Error("log.error was never called");
  const lastCall = calls[calls.length - 1] as unknown[];
  // The facade calls log.error(buildMeta(...), message) — message is arg[1].
  return lastCall[1] as string;
}

// ---------------------------------------------------------------------------
// onUncaughtException
// ---------------------------------------------------------------------------

describe("onUncaughtException", () => {
  test("logs the error message/stack when an Error instance is given", () => {
    const err = new Error("boom");
    onUncaughtException(err);

    expect(mockElectronLogError).toHaveBeenCalledTimes(1);
    const msg = lastErrorMsg();
    expect(msg).toContain("Uncaught exception");
    expect(msg).toContain("boom");
  });

  test("logs a string representation when a non-Error value is thrown", () => {
    // TypeScript types the parameter as Error, but at runtime anything can be
    // thrown; we test this edge-case with a cast.
    onUncaughtException("raw string error" as unknown as Error);

    expect(mockElectronLogError).toHaveBeenCalledTimes(1);
    const msg = lastErrorMsg();
    expect(msg).toContain("raw string error");
  });
});

// ---------------------------------------------------------------------------
// onUnhandledRejection
// ---------------------------------------------------------------------------

describe("onUnhandledRejection", () => {
  test("logs the rejection reason when an Error is given", () => {
    const err = new Error("rejected promise");
    onUnhandledRejection(err);

    expect(mockElectronLogError).toHaveBeenCalledTimes(1);
    const msg = lastErrorMsg();
    expect(msg).toContain("Unhandled promise rejection");
    expect(msg).toContain("rejected promise");
  });

  test("logs a string representation when the reason is a primitive", () => {
    onUnhandledRejection(42);

    expect(mockElectronLogError).toHaveBeenCalledTimes(1);
    const msg = lastErrorMsg();
    expect(msg).toContain("42");
  });

  test("logs a non-empty string when the reason is null", () => {
    onUnhandledRejection(null);

    expect(mockElectronLogError).toHaveBeenCalledTimes(1);
    const msg = lastErrorMsg();
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// installErrorSafetyNet
// ---------------------------------------------------------------------------

describe("installErrorSafetyNet", () => {
  test("registers one uncaughtException and one unhandledRejection listener", () => {
    // Clear any listeners left by earlier test runs or module evaluation.
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");

    installErrorSafetyNet();

    expect(process.listenerCount("uncaughtException")).toBe(1);
    expect(process.listenerCount("unhandledRejection")).toBe(1);

    // Restore to avoid leaking into subsequent tests.
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
  });
});
