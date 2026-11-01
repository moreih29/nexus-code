/**
 * Scenario-based tests for window-error-handler.ts.
 *
 * Verifies:
 *  1. isPureCanceled — classification of cancellation vs. real errors.
 *  2. installWindowErrorHandlers — listener registration / teardown.
 *  3. 'unhandledrejection' handler — Canceled rejections are silent (no log);
 *     real rejections are logged.
 *  4. 'error' handler — Canceled errors are silent; real errors are logged.
 *
 * electron-log/renderer is mocked so the facade can be imported without a live
 * Electron IPC channel.
 *
 * The test captures the installed listener functions via the stubbed
 * window.addEventListener and invokes them directly — this avoids requiring
 * window.dispatchEvent (absent in the minimal IPC stub) while still exercising
 * the handler logic in isolation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Stub window.ipc so ipc/client loads without Electron preload.
// Also provide addEventListener/removeEventListener so electron-log/renderer's
// module-init code (which calls window.addEventListener("message", ...)) does
// not throw an "Unhandled error between tests" when it is first loaded in this
// test worker's context before the mock.module() call takes effect.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ---------------------------------------------------------------------------
// Mock electron-log/renderer so createLogger never tries IPC
// ---------------------------------------------------------------------------

const logged: { level: string; args: unknown[] }[] = [];

mock.module("electron-log/renderer", () => ({
  default: {
    error: (...args: unknown[]) => logged.push({ level: "error", args }),
    warn: (...args: unknown[]) => logged.push({ level: "warn", args }),
    info: (...args: unknown[]) => logged.push({ level: "info", args }),
    debug: (...args: unknown[]) => logged.push({ level: "debug", args }),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  installWindowErrorHandlers,
  isPureCanceled,
} from "../../../../src/renderer/services/window-error-handler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown) => void;

/**
 * Creates a window stub that records addEventListener / removeEventListener
 * calls and exposes a `handlers` map for direct handler invocation.
 */
function makeWindowStub(): {
  stub: Record<string, unknown>;
  added: { type: string; fn: EventHandler }[];
  removed: { type: string; fn: EventHandler }[];
  invoke(type: string, event: unknown): void;
} {
  const added: { type: string; fn: EventHandler }[] = [];
  const removed: { type: string; fn: EventHandler }[] = [];

  const stub = {
    ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
    addEventListener(type: string, fn: EventHandler) {
      added.push({ type, fn });
    },
    removeEventListener(type: string, fn: EventHandler) {
      removed.push({ type, fn });
    },
  };

  function invoke(type: string, event: unknown): void {
    for (const entry of added) {
      if (entry.type === type) {
        entry.fn(event);
      }
    }
  }

  return { stub, added, removed, invoke };
}

/** Build a minimal PromiseRejectionEvent-like object for testing. */
function makeRejectionEvent(
  reason: unknown,
): { reason: unknown; defaultPrevented: boolean; preventDefault(): void } {
  let prevented = false;
  return {
    reason,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

/** Build a minimal ErrorEvent-like object for testing. */
function makeErrorEvent(
  error: unknown,
): { error: unknown; defaultPrevented: boolean; preventDefault(): void } {
  let prevented = false;
  return {
    error,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

// ---------------------------------------------------------------------------
// isPureCanceled
// ---------------------------------------------------------------------------

describe("isPureCanceled — cancellation detection", () => {
  test("returns true for { name: 'Canceled' }", () => {
    expect(isPureCanceled({ name: "Canceled" })).toBe(true);
  });

  test("returns true for { message: 'Canceled' }", () => {
    expect(isPureCanceled({ message: "Canceled" })).toBe(true);
  });

  test("returns false for a generic Error object", () => {
    expect(isPureCanceled(new Error("something went wrong"))).toBe(false);
  });

  test("returns false for a string reason", () => {
    expect(isPureCanceled("Canceled")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isPureCanceled(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isPureCanceled(undefined)).toBe(false);
  });

  test("returns false for an object with unrelated fields", () => {
    expect(isPureCanceled({ code: "ENOENT", message: "File not found" })).toBe(false);
  });

  test("returns false for an object with name 'AbortError' (not our sentinel)", () => {
    expect(isPureCanceled({ name: "AbortError" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// installWindowErrorHandlers — listener registration and teardown
// ---------------------------------------------------------------------------

describe("installWindowErrorHandlers — listener registration and teardown", () => {
  let windowStub: ReturnType<typeof makeWindowStub>;

  beforeEach(() => {
    logged.length = 0;
    windowStub = makeWindowStub();
    (globalThis as Record<string, unknown>).window = windowStub.stub;
  });

  test("teardown removes exactly the listeners it added", () => {
    const teardown = installWindowErrorHandlers();
    teardown();

    expect(windowStub.added.map((l) => l.type).sort()).toEqual(["error", "unhandledrejection"]);
    expect(windowStub.removed).toEqual(windowStub.added);
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — unhandledrejection
// ---------------------------------------------------------------------------

describe("unhandledrejection handler — Canceled rejection is silent", () => {
  let windowStub: ReturnType<typeof makeWindowStub>;
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    logged.length = 0;
    windowStub = makeWindowStub();
    (globalThis as Record<string, unknown>).window = windowStub.stub;
    teardown = installWindowErrorHandlers();
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  test("Canceled rejection: suppressed, nothing is logged", () => {
    const event = makeRejectionEvent({ name: "Canceled" });
    windowStub.invoke("unhandledrejection", event);

    expect(event.defaultPrevented).toBe(true);
    expect(logged.filter((l) => l.level === "error").length).toBe(0);
  });

  test("real rejection: error is logged and left to the runtime", () => {
    const event = makeRejectionEvent(new Error("network timeout"));
    windowStub.invoke("unhandledrejection", event);

    expect(event.defaultPrevented).toBe(false);
    expect(logged.filter((l) => l.level === "error").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — error (synchronous)
// ---------------------------------------------------------------------------

describe("error handler — Canceled error is silent", () => {
  let windowStub: ReturnType<typeof makeWindowStub>;
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    logged.length = 0;
    windowStub = makeWindowStub();
    (globalThis as Record<string, unknown>).window = windowStub.stub;
    teardown = installWindowErrorHandlers();
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  test("Canceled error: suppressed, nothing is logged", () => {
    const event = makeErrorEvent({ name: "Canceled" });
    windowStub.invoke("error", event);

    expect(event.defaultPrevented).toBe(true);
    expect(logged.filter((l) => l.level === "error").length).toBe(0);
  });

  test("real synchronous error: error is logged and left to the runtime", () => {
    const event = makeErrorEvent(new Error("unexpected crash"));
    windowStub.invoke("error", event);

    expect(event.defaultPrevented).toBe(false);
    expect(logged.filter((l) => l.level === "error").length).toBeGreaterThan(0);
  });
});
