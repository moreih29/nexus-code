import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { FileMatch, SearchComplete } from "../../../../../src/shared/search/types";

interface ControlledStream {
  promise: Promise<SearchComplete>;
  resolve: (value: SearchComplete) => void;
  reject: (reason: unknown) => void;
  callbacks: Set<(batch: FileMatch[]) => void>;
  emitProgress: (batch: FileMatch[]) => void;
  signal?: AbortSignal;
  args: unknown;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const controlledStreams: ControlledStream[] = [];

const mockIpcStream = mock(
  (_channel: string, _method: string, args: unknown, opts?: { signal?: AbortSignal }) => {
    const completion = deferred<SearchComplete>();
    const callbacks = new Set<(batch: FileMatch[]) => void>();
    const stream: ControlledStream = {
      promise: completion.promise,
      resolve: completion.resolve,
      reject: completion.reject,
      callbacks,
      signal: opts?.signal,
      args,
      emitProgress(batch) {
        for (const callback of Array.from(callbacks)) {
          callback(batch);
        }
      },
    };
    controlledStreams.push(stream);

    return {
      promise: stream.promise,
      onProgress(callback: (batch: FileMatch[]) => void) {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
    };
  },
);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcStream: mockIpcStream,
}));

mock.module("../../../../../src/renderer/state/stores/panel-view-options", () => ({
  usePanelViewOptionsStore: {
    getState: () => ({
      closeForWorkspace: () => {},
    }),
  },
}));

mock.module("../../../../../src/renderer/state/workspace-cleanup", () => ({
  registerWorkspaceCleanup: mock(() => () => {}),
}));

import {
  EMPTY_SEARCH_OPTIONS,
  type SearchOptions,
  useSearchStore,
} from "../../../../../src/renderer/state/stores/search";

const WS_A = "00000000-0000-0000-0000-0000000000aa";
const WS_B = "00000000-0000-0000-0000-0000000000bb";
const BASE_OPTIONS: SearchOptions = { ...EMPTY_SEARCH_OPTIONS };

function resetStore(): void {
  useSearchStore.getState().closeAllForWorkspace(WS_A);
  useSearchStore.getState().closeAllForWorkspace(WS_B);
  useSearchStore.setState({ sessions: new Map(), expandedDirsByWorkspace: new Map() });
  controlledStreams.length = 0;
  mockIpcStream.mockClear();
}

function batch(relPath: string, preview: string): FileMatch[] {
  return [
    {
      relPath,
      matches: [{ range: { line: 0, startCol: 0, endCol: 6 }, preview }],
    },
  ];
}

function latestStream(): ControlledStream {
  const stream = controlledStreams.at(-1);
  if (!stream) throw new Error("expected an ipcStream call");
  return stream;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("renderer search store", () => {
  beforeEach(resetStore);

  it("startSearch creates a running session and calls ipcStream with args and signal", () => {
    useSearchStore.getState().startSearch(WS_A, "hello", BASE_OPTIONS);

    const session = useSearchStore.getState().sessions.get(WS_A);
    expect(session).toBeDefined();
    expect(session!.query).toBe("hello");
    expect(session!.options).toEqual(BASE_OPTIONS);
    expect(session!.status).toBe("running");
    expect(session!.results).toEqual([]);
    expect(session!.limitHit).toBe(false);
    expect(session!.filesScanned).toBe(0);
    expect(session!.matchesFound).toBe(0);
    expect(session!.elapsedMs).toBe(0);
    expect(session!.errorMessage).toBeUndefined();

    expect(mockIpcStream).toHaveBeenCalledTimes(1);
    const [channel, method, args, opts] = mockIpcStream.mock.calls[0] as [
      string,
      string,
      { workspaceId: string; query: { pattern: string } },
      { signal: AbortSignal },
    ];
    expect(channel).toBe("fs");
    expect(method).toBe("searchText");
    expect(args).toEqual({ workspaceId: WS_A, query: { pattern: "hello", ...BASE_OPTIONS } });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(latestStream().signal).toBe(opts.signal);
  });

  it("progress appends new groups and merges matches for an existing group", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const stream = latestStream();

    stream.emitProgress(batch("src/index.ts", "needle one"));
    stream.emitProgress(batch("src/index.ts", "needle two"));
    stream.emitProgress(batch("src/other.ts", "needle three"));

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.results).toHaveLength(2);
    expect(session.results[0].relPath).toBe("src/index.ts");
    expect(session.results[0].expanded).toBe(true);
    expect(session.results[0].matches.map((match) => match.preview)).toEqual([
      "needle one",
      "needle two",
    ]);
    expect(session.results[1].relPath).toBe("src/other.ts");
    expect(session.matchesFound).toBe(3);
  });

  it("complete sets status done and writes final counts", async () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const stream = latestStream();

    stream.emitProgress(batch("src/index.ts", "needle"));
    stream.resolve({ filesScanned: 8, matchesFound: 4, limitHit: true, elapsedMs: 42 });
    await flushPromises();

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.status).toBe("done");
    expect(session.filesScanned).toBe(8);
    expect(session.matchesFound).toBe(4);
    expect(session.limitHit).toBe(true);
    expect(session.elapsedMs).toBe(42);
  });

  it("cancelSearch aborts the signal, sets status idle, and keeps partial results", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const stream = latestStream();
    stream.emitProgress(batch("src/index.ts", "needle"));

    useSearchStore.getState().cancelSearch(WS_A);

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(stream.signal?.aborted).toBe(true);
    expect(session.status).toBe("idle");
    expect(session.results).toHaveLength(1);
    expect(session.matchesFound).toBe(1);
  });

  it("a new startSearch aborts the prior controller and ignores stale progress/errors", async () => {
    useSearchStore.getState().startSearch(WS_A, "first", BASE_OPTIONS);
    const first = latestStream();

    useSearchStore.getState().startSearch(WS_A, "second", BASE_OPTIONS);
    const second = latestStream();

    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);

    first.emitProgress(batch("old.ts", "stale needle"));
    first.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await flushPromises();

    let session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.query).toBe("second");
    expect(session.status).toBe("running");
    expect(session.results).toEqual([]);

    second.emitProgress(batch("fresh.ts", "fresh needle"));
    session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.results.map((group) => group.relPath)).toEqual(["fresh.ts"]);
    expect(session.matchesFound).toBe(1);
  });

  it("non-abort stream errors set status error", async () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    latestStream().reject(new Error("disk full"));
    await flushPromises();

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.status).toBe("error");
    expect(session.errorMessage).toBe("disk full");
  });

  it("toggleGroup flips only the requested result group", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const stream = latestStream();
    stream.emitProgress(batch("a.ts", "needle a"));
    stream.emitProgress(batch("b.ts", "needle b"));

    useSearchStore.getState().toggleGroup(WS_A, "a.ts");

    const results = useSearchStore.getState().sessions.get(WS_A)!.results;
    expect(results.find((group) => group.relPath === "a.ts")!.expanded).toBe(false);
    expect(results.find((group) => group.relPath === "b.ts")!.expanded).toBe(true);
  });

  it("closeAllForWorkspace aborts in-flight search and removes only that workspace", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const first = latestStream();
    useSearchStore.getState().startSearch(WS_B, "other", BASE_OPTIONS);
    const second = latestStream();

    useSearchStore.getState().closeAllForWorkspace(WS_A);

    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);
    expect(useSearchStore.getState().sessions.has(WS_A)).toBe(false);
    expect(useSearchStore.getState().sessions.has(WS_B)).toBe(true);
  });

  it("clearSearch aborts in-flight stream and removes the session entirely", () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const stream = latestStream();
    stream.emitProgress(batch("a.ts", "needle a"));

    expect(useSearchStore.getState().sessions.get(WS_A)!.results.length).toBe(1);

    useSearchStore.getState().clearSearch(WS_A);

    expect(stream.signal?.aborted).toBe(true);
    expect(useSearchStore.getState().sessions.has(WS_A)).toBe(false);
  });

  it("clearSearch removes a completed session (results no longer survive an empty input)", async () => {
    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    const stream = latestStream();
    stream.emitProgress(batch("a.ts", "needle a"));
    stream.resolve({
      filesScanned: 1,
      matchesFound: 1,
      limitHit: false,
      elapsedMs: 1,
    });
    await flushPromises();

    expect(useSearchStore.getState().sessions.get(WS_A)!.status).toBe("done");

    useSearchStore.getState().clearSearch(WS_A);

    expect(useSearchStore.getState().sessions.has(WS_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toggleExpandedDir actions
// ---------------------------------------------------------------------------

describe("search store — toggleExpandedDir", () => {
  beforeEach(resetStore);

  it("toggleExpandedDir adds a dir path; toggling again removes it", () => {
    useSearchStore.getState().toggleExpandedDir(WS_A, "src/components");
    expect(
      useSearchStore.getState().expandedDirsByWorkspace.get(WS_A)?.has("src/components"),
    ).toBe(true);

    useSearchStore.getState().toggleExpandedDir(WS_A, "src/components");
    expect(
      useSearchStore.getState().expandedDirsByWorkspace.get(WS_A)?.has("src/components"),
    ).toBe(false);
  });

  it("closeAllForWorkspace removes expandedDirsByWorkspace entry for workspace", () => {
    useSearchStore.getState().toggleExpandedDir(WS_A, "src");

    useSearchStore.getState().closeAllForWorkspace(WS_A);

    expect(useSearchStore.getState().expandedDirsByWorkspace.has(WS_A)).toBe(false);
  });
});
