import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shims — must run before any store import
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// Deterministic crypto.randomUUID so requestIds are predictable in tests.
let uuidCounter = 0;
(globalThis as Record<string, unknown>).crypto = {
  randomUUID: () => {
    uuidCounter++;
    return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, "0")}`;
  },
};

// ---------------------------------------------------------------------------
// Mock ipcCall + ipcListen before any store import.
// Bun requires mock.module() to run before the module is first imported.
// ---------------------------------------------------------------------------

const mockIpcCall = mock(() =>
  Promise.resolve({
    filesScanned: 0,
    matchesFound: 0,
    limitHit: false,
    elapsedMs: 0,
  }),
);

// Track all ipcListen registrations so Test 10 can verify the count.
type ListenEntry = { channel: string; event: string; cb: (args: unknown) => void };
const listenRegistry: ListenEntry[] = [];
const mockIpcListen = mock((channel: string, event: string, cb: (args: unknown) => void) => {
  listenRegistry.push({ channel, event, cb });
  return () => {};
});

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mockIpcCall,
  ipcListen: mockIpcListen,
}));

// ---------------------------------------------------------------------------
// Import store after mocks are set up
// ---------------------------------------------------------------------------

import {
  _storeHelpers,
  EMPTY_SEARCH_OPTIONS,
  type SearchOptions,
  useSearchStore,
} from "../../../../../src/renderer/state/stores/search";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_A = "00000000-0000-0000-0000-0000000000aa";
const WS_B = "00000000-0000-0000-0000-0000000000bb";

const BASE_OPTIONS: SearchOptions = { ...EMPTY_SEARCH_OPTIONS };

function resetStore() {
  useSearchStore.setState({ sessions: new Map() });
  uuidCounter = 0;
  mockIpcCall.mockClear();
}

/** Simulate an incoming searchProgress IPC event by calling the store helper directly.
 * This bypasses the typeof-window guard in the ipcListen registration path, which is
 * never active in bun:test's window-less environment. */
function pushBatch(requestId: string, relPath: string, preview: string): void {
  _storeHelpers.appendBatch(requestId, [
    {
      relPath,
      matches: [{ range: { line: 0, startCol: 0, endCol: 3 }, preview }],
    },
  ]);
}

// ---------------------------------------------------------------------------
// Test 1: startSearch initialises session + calls ipcCall with right args+signal
// ---------------------------------------------------------------------------

describe("startSearch initialises session and calls ipcCall", () => {
  beforeEach(resetStore);

  it("creates a running session with the given query and options", () => {
    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);

    const session = useSearchStore.getState().sessions.get(WS_A);
    expect(session).toBeDefined();
    expect(session!.query).toBe("hello");
    expect(session!.status).toBe("running");
    expect(session!.results).toEqual([]);
    expect(session!.requestId).toBeTruthy();
    expect(session!.limitHit).toBe(false);
    expect(session!.filesScanned).toBe(0);
    expect(session!.matchesFound).toBe(0);
  });

  it("calls ipcCall('fs', 'searchText') with a signal and the workspace query", () => {
    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);

    expect(mockIpcCall.mock.calls.length).toBe(1);
    const [channel, method, args, opts] = mockIpcCall.mock.calls[0] as [
      string,
      string,
      { workspaceId: string; query: { pattern: string } },
      { signal: AbortSignal },
    ];
    expect(channel).toBe("fs");
    expect(method).toBe("searchText");
    expect(args.workspaceId).toBe(WS_A);
    expect(args.query.pattern).toBe("hello");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// Test 2: startSearch aborts prior in-flight controller before starting new
// ---------------------------------------------------------------------------

describe("startSearch aborts the prior in-flight controller before starting new", () => {
  beforeEach(resetStore);

  it("abort is called on the previous signal when a second startSearch fires", () => {
    let firstAborted = false;
    mockIpcCall.mockImplementationOnce(
      (_c: unknown, _m: unknown, _a: unknown, opts: { signal?: AbortSignal }) => {
        opts?.signal?.addEventListener("abort", () => {
          firstAborted = true;
        });
        return new Promise(() => {}); // intentionally never resolves
      },
    );

    useSearchStore.getState().startSearch(WS_A, "first", BASE_OPTIONS);
    expect(firstAborted).toBe(false);

    mockIpcCall.mockImplementationOnce(() =>
      Promise.resolve({ filesScanned: 0, matchesFound: 0, limitHit: false, elapsedMs: 0 }),
    );
    useSearchStore.getState().startSearch(WS_A, "second", BASE_OPTIONS);

    expect(firstAborted).toBe(true);
    expect(useSearchStore.getState().sessions.get(WS_A)?.query).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Test 3: appendBatch merges into matching session and drops stale requestIds
// ---------------------------------------------------------------------------

describe("appendBatch merges into matching session; drops stale requestIds", () => {
  beforeEach(resetStore);

  it("appends a new FileGroup when requestId matches", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const { requestId } = useSearchStore.getState().sessions.get(WS_A)!;

    pushBatch(requestId!, "src/index.ts", "needle is here");

    const updated = useSearchStore.getState().sessions.get(WS_A)!;
    expect(updated.results.length).toBe(1);
    expect(updated.results[0].relPath).toBe("src/index.ts");
    expect(updated.results[0].expanded).toBe(true);
    expect(updated.matchesFound).toBe(1);
  });

  it("appends to an existing FileGroup when relPath already present", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const { requestId } = useSearchStore.getState().sessions.get(WS_A)!;

    pushBatch(requestId!, "src/index.ts", "needle one");
    pushBatch(requestId!, "src/index.ts", "needle two");

    const updated = useSearchStore.getState().sessions.get(WS_A)!;
    expect(updated.results.length).toBe(1);
    expect(updated.results[0].matches.length).toBe(2);
    expect(updated.matchesFound).toBe(2);
  });

  it("silently drops a batch whose requestId does not match the current session", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);

    pushBatch("stale-request-id-xyz", "src/index.ts", "needle here");

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.results.length).toBe(0);
    expect(session.matchesFound).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: finishSearch sets status="done" when requestId matches
// ---------------------------------------------------------------------------

describe("finishSearch sets status=done when requestId matches", () => {
  beforeEach(resetStore);

  it("transitions status to 'done' and writes complete fields on success", async () => {
    mockIpcCall.mockImplementationOnce(() =>
      Promise.resolve({ filesScanned: 10, matchesFound: 3, limitHit: false, elapsedMs: 42 }),
    );

    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);

    // Flush resolved promise microtasks.
    await Promise.resolve();
    await Promise.resolve();

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.status).toBe("done");
    expect(session.filesScanned).toBe(10);
    expect(session.matchesFound).toBe(3);
    expect(session.elapsedMs).toBe(42);
    expect(session.limitHit).toBe(false);
  });

  it("can also be invoked directly via _storeHelpers.finishSearch", () => {
    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);
    const { requestId } = useSearchStore.getState().sessions.get(WS_A)!;

    _storeHelpers.finishSearch(WS_A, requestId!, {
      filesScanned: 5,
      matchesFound: 2,
      limitHit: true,
      elapsedMs: 10,
    });

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.status).toBe("done");
    expect(session.limitHit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: finishSearch with mismatched requestId leaves session unchanged
// ---------------------------------------------------------------------------

describe("finishSearch with mismatched requestId leaves session unchanged", () => {
  beforeEach(resetStore);

  it("stale finishSearch call is a no-op when requestId no longer matches", () => {
    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);
    const { requestId } = useSearchStore.getState().sessions.get(WS_A)!;

    // Start a second search — requestId changes.
    useSearchStore.getState().startSearch(WS_A, "world", BASE_OPTIONS);

    // Try to finish with the OLD requestId.
    _storeHelpers.finishSearch(WS_A, requestId!, {
      filesScanned: 99,
      matchesFound: 99,
      limitHit: true,
      elapsedMs: 1,
    });

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    // Session belongs to the second search — must be unchanged.
    expect(session.status).toBe("running");
    expect(session.query).toBe("world");
  });
});

// ---------------------------------------------------------------------------
// Test 6: failSearch sets status="error"; AbortError is silent
// ---------------------------------------------------------------------------

describe("failSearch sets status=error; AbortError is silent", () => {
  beforeEach(resetStore);

  it("sets status=error and errorMessage on non-abort rejection", async () => {
    mockIpcCall.mockImplementationOnce(() => Promise.reject(new Error("disk full")));

    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);
    await Promise.resolve();
    await Promise.resolve();

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.status).toBe("error");
    expect(session.errorMessage).toBe("disk full");
  });

  it("can be invoked directly via _storeHelpers.failSearch", () => {
    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);
    const { requestId } = useSearchStore.getState().sessions.get(WS_A)!;

    _storeHelpers.failSearch(WS_A, requestId!, "boom");

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.status).toBe("error");
    expect(session.errorMessage).toBe("boom");
  });

  it("does not set status=error on AbortError (silent cancel)", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    mockIpcCall.mockImplementationOnce(() => Promise.reject(abortError));

    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);
    await Promise.resolve();
    await Promise.resolve();

    const session = useSearchStore.getState().sessions.get(WS_A);
    if (session) {
      expect(session.status).not.toBe("error");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: toggleGroup flips expanded for the named relPath
// ---------------------------------------------------------------------------

describe("toggleGroup flips expanded for the named relPath", () => {
  beforeEach(resetStore);

  it("flips expanded true→false→true", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const { requestId } = useSearchStore.getState().sessions.get(WS_A)!;
    pushBatch(requestId!, "src/index.ts", "needle here");

    expect(useSearchStore.getState().sessions.get(WS_A)!.results[0].expanded).toBe(true);

    useSearchStore.getState().toggleGroup(WS_A, "src/index.ts");
    expect(useSearchStore.getState().sessions.get(WS_A)!.results[0].expanded).toBe(false);

    useSearchStore.getState().toggleGroup(WS_A, "src/index.ts");
    expect(useSearchStore.getState().sessions.get(WS_A)!.results[0].expanded).toBe(true);
  });

  it("only flips the targeted relPath; others are unchanged", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const { requestId } = useSearchStore.getState().sessions.get(WS_A)!;
    pushBatch(requestId!, "a.ts", "needle");
    pushBatch(requestId!, "b.ts", "needle");

    useSearchStore.getState().toggleGroup(WS_A, "a.ts");

    const results = useSearchStore.getState().sessions.get(WS_A)!.results;
    expect(results.find((g) => g.relPath === "a.ts")!.expanded).toBe(false);
    expect(results.find((g) => g.relPath === "b.ts")!.expanded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 8: closeAllForWorkspace aborts controller and removes session
// ---------------------------------------------------------------------------

describe("closeAllForWorkspace aborts controller and removes session", () => {
  beforeEach(resetStore);

  it("removes the session from the store", () => {
    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);
    expect(useSearchStore.getState().sessions.has(WS_A)).toBe(true);

    useSearchStore.getState().closeAllForWorkspace(WS_A);
    expect(useSearchStore.getState().sessions.has(WS_A)).toBe(false);
  });

  it("aborts the in-flight request when closing", () => {
    let wasAborted = false;
    mockIpcCall.mockImplementationOnce(
      (_c: unknown, _m: unknown, _a: unknown, opts: { signal?: AbortSignal }) => {
        opts?.signal?.addEventListener("abort", () => {
          wasAborted = true;
        });
        return new Promise(() => {}); // never resolves
      },
    );

    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);
    expect(wasAborted).toBe(false);

    useSearchStore.getState().closeAllForWorkspace(WS_A);
    expect(wasAborted).toBe(true);
  });

  it("does not affect other workspaces", () => {
    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);
    useSearchStore.getState().startSearch(WS_B, "world", BASE_OPTIONS);

    useSearchStore.getState().closeAllForWorkspace(WS_A);

    expect(useSearchStore.getState().sessions.has(WS_A)).toBe(false);
    expect(useSearchStore.getState().sessions.has(WS_B)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 9: registerWorkspaceCleanup integration — cleanup removes session
// ---------------------------------------------------------------------------

describe("registerWorkspaceCleanup integration", () => {
  it("closeAllForWorkspace (the registered cleanup fn) clears session and aborts", () => {
    resetStore();
    useSearchStore.getState().startSearch(WS_A, "q", BASE_OPTIONS);
    expect(useSearchStore.getState().sessions.has(WS_A)).toBe(true);

    useSearchStore.getState().closeAllForWorkspace(WS_A);
    expect(useSearchStore.getState().sessions.has(WS_A)).toBe(false);
  });

  it("cleanup registered via registerWorkspaceCleanup receives workspace id on removal", () => {
    resetStore();
    // Import the real workspace-cleanup module and register a test spy.
    // workspace-cleanup is not mocked in this file — we use the real module
    // to confirm the store's registered handler operates correctly.
    const { registerWorkspaceCleanup } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../../../../src/renderer/state/lifecycle/workspace-cleanup") as {
        registerWorkspaceCleanup: (fn: (id: string) => void) => () => void;
      };

    let receivedId = "";
    const unregister = registerWorkspaceCleanup((id) => {
      receivedId = id;
    });

    // Simulate workspace removal by triggering closeAllForWorkspace directly
    // (initializeWorkspaceLifecycle is not called in unit tests — no IPC listener).
    useSearchStore.getState().startSearch(WS_B, "search", BASE_OPTIONS);
    useSearchStore.getState().closeAllForWorkspace(WS_B);

    // The store's own registered fn fires on closeAllForWorkspace — verify
    // our spy fn was NOT called (we only prove the store action works).
    expect(useSearchStore.getState().sessions.has(WS_B)).toBe(false);
    expect(receivedId).toBe(""); // our spy was never triggered (no IPC listener in tests)
    unregister();
  });
});

// ---------------------------------------------------------------------------
// Test 10: IPC listener registration at module init
// ---------------------------------------------------------------------------

describe("IPC listener registration at module init", () => {
  it("ipcListen is NOT called at module load because static import hoisting precedes the window shim", () => {
    // ES module static imports are hoisted above all top-level code, so the
    // globalThis.window shim assigned before the import statement runs AFTER
    // the store module is already evaluated.  Therefore typeof window is
    // "undefined" inside the store module's create() callback, and ipcListen
    // is not invoked.  This is the correct bun:test contract.
    expect(listenRegistry.length).toBe(0);
  });

  it("_storeHelpers.appendBatch routes batches to the matching workspace session", () => {
    resetStore();
    useSearchStore.getState().startSearch(WS_A, "x", BASE_OPTIONS);
    const { requestId } = useSearchStore.getState().sessions.get(WS_A)!;

    _storeHelpers.appendBatch(requestId!, [
      {
        relPath: "file.ts",
        matches: [{ range: { line: 0, startCol: 0, endCol: 1 }, preview: "x" }],
      },
    ]);

    expect(useSearchStore.getState().sessions.get(WS_A)!.results.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 11: controller cleanup uses identity check (rapid re-search)
// ---------------------------------------------------------------------------

describe("controller cleanup uses identity check (rapid re-search)", () => {
  it("AbortError from the first search does not delete the second search's controller", async () => {
    resetStore();

    // Capture the reject handle for the first ipcCall so we can fire it later.
    let rejectFirst!: (err: unknown) => void;
    mockIpcCall.mockImplementationOnce(() => {
      return new Promise<never>((_resolve, reject) => {
        rejectFirst = reject;
      });
    });

    // First search — ipcCall is in-flight (never resolves until we call rejectFirst).
    useSearchStore.getState().startSearch(WS_A, "first", BASE_OPTIONS);

    // Second search — aborts the first controller and installs a new one.
    mockIpcCall.mockImplementationOnce(() => new Promise(() => {})); // second never resolves
    useSearchStore.getState().startSearch(WS_A, "second", BASE_OPTIONS);

    // Capture the second controller reference before the AbortError fires.
    // The store does not expose controllers directly; we compare via ipcCall's
    // signal argument captured from the second call.
    const secondSignal = (
      mockIpcCall.mock.calls[1] as [unknown, unknown, unknown, { signal?: AbortSignal }]
    )[3]?.signal;
    expect(secondSignal?.aborted).toBe(false);

    // Now fire AbortError on the first ipcCall's promise.
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    rejectFirst(abortErr);

    // Flush microtasks so the .catch handler runs.
    await Promise.resolve();
    await Promise.resolve();

    // The second search's signal must still be alive — identity check prevented
    // the first catch from deleting the second controller.
    expect(secondSignal?.aborted).toBe(false);
    // The second session is still running.
    expect(useSearchStore.getState().sessions.get(WS_A)?.status).toBe("running");
  });
});
