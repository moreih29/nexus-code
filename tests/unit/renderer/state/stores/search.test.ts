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
});
