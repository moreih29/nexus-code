import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const logged: { level: string; args: unknown[] }[] = [];

mock.module("electron-log/renderer", () => ({
  default: {
    error: (...args: unknown[]) => logged.push({ level: "error", args }),
    warn: (...args: unknown[]) => logged.push({ level: "warn", args }),
    info: (...args: unknown[]) => logged.push({ level: "info", args }),
    debug: (...args: unknown[]) => logged.push({ level: "debug", args }),
  },
}));

import { installWindowErrorHandlers } from "../../../../src/renderer/services/window-error-handler";

type EventHandler = (event: unknown) => void;

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

function makeRejectionEvent(reason: unknown): {
  reason: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
} {
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

function makeErrorEvent(error: unknown): {
  error: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
} {
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

describe("error handler — what an uncaught error leaves in the log", () => {
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

  const uncaught = () => {
    const entries = logged.filter((l) => l.level === "error");
    expect(entries).toHaveLength(1);
    return entries[0]!;
  };

  test("an error keeps its name, file basename, line and column, nothing else", () => {
    const error = new TypeError("token sk-secret-123 in C:\\Users\\kim\\notes.md");
    const event = Object.assign(makeErrorEvent(error), {
      message: "Uncaught TypeError: token sk-secret-123 in C:\\Users\\kim\\notes.md",
      filename:
        "file:///C:/Users/kim/AppData/Local/NexusCode/out/renderer/assets/index-abc.js?v=1#x",
      lineno: 12,
      colno: 34,
    });
    windowStub.invoke("error", event);
    const entry = uncaught();
    expect(entry.args).toContain(
      'Uncaught renderer error name="TypeError" source="index-abc.js:12:34" errorNull=false resizeObserverLoop=false',
    );
    const text = JSON.stringify(entry.args);
    for (const leaked of ["sk-secret-123", "kim", "AppData", "notes.md", "at ", "stack"]) {
      expect(text).not.toContain(leaked);
    }
  });

  test("a ResizeObserver loop with no error object says so", () => {
    const event = Object.assign(makeErrorEvent(null), {
      message: "ResizeObserver loop completed with undelivered notifications.",
      filename: "",
      lineno: 0,
      colno: 0,
    });
    windowStub.invoke("error", event);
    expect(uncaught().args).toContain(
      'Uncaught renderer error name="none" source="none:0:0" errorNull=true resizeObserverLoop=true',
    );
  });
});

describe("error handler — what an uncaught error records for a bug report", () => {
  let windowStub: ReturnType<typeof makeWindowStub>;
  let teardown: (() => void) | null = null;
  const calls: unknown[][] = [];

  beforeEach(() => {
    logged.length = 0;
    calls.length = 0;
    windowStub = makeWindowStub();
    windowStub.stub.ipc = {
      call: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(null);
      },
      listen: () => {},
      off: () => {},
    };
    (globalThis as Record<string, unknown>).window = windowStub.stub;
    teardown = installWindowErrorHandlers();
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  test("an error: its name and where it was thrown, never its message", () => {
    const event = Object.assign(makeErrorEvent(new TypeError("note text: 첫 번째 문장")), {
      message: "Uncaught TypeError: note text: 첫 번째 문장",
      filename: "file:///Users/kim/NexusCode/out/renderer/assets/index-abc.js",
      lineno: 12,
      colno: 34,
    });
    windowStub.invoke("error", event);
    expect(calls).toEqual([
      [
        "system",
        "recordError",
        { area: "app", code: "renderer:type_error", message: "at index-abc.js:12:34" },
      ],
    ]);
  });

  test("a rejection: its name alone; a ResizeObserver loop or a cancel: nothing", () => {
    windowStub.invoke("unhandledrejection", makeRejectionEvent(new RangeError("secret")));
    windowStub.invoke("unhandledrejection", makeRejectionEvent({ name: "Canceled" }));
    windowStub.invoke(
      "error",
      Object.assign(makeErrorEvent(null), {
        message: "ResizeObserver loop completed with undelivered notifications.",
        filename: "",
        lineno: 0,
        colno: 0,
      }),
    );
    expect(calls).toEqual([
      ["system", "recordError", { area: "app", code: "renderer_rejection:range_error" }],
    ]);
  });
});
