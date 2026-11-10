import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { StreamContext } from "../../src/main/infra/ipc-router";
import {
  EMPTY_SEARCH_OPTIONS,
  type SearchOptions,
  useSearchStore,
} from "../../src/renderer/state/stores/search";
import type { FileMatch, SearchComplete } from "../../src/shared/search/types";
import {
  createIpcPair,
  installWindowForPair,
  mockGetAllWebContents,
  mockIpcMain,
  resetInMemoryIpc,
  setupInMemoryRouter,
  waitFor,
} from "../helpers/ipc-pair";

// Re-establish the electron mock in case a sibling test file in the same bun
// worker has overwritten it (mock.module persists across files in a worker).
mock.module("electron", () => ({
  ipcMain: mockIpcMain,
  webContents: { getAllWebContents: mockGetAllWebContents },
  shell: { showItemInFolder: mock((_path: string) => {}) },
}));

const WS_A = "123e4567-e89b-12d3-a456-426614174001";
const WS_B = "123e4567-e89b-12d3-a456-426614174002";
const BASE_OPTIONS: SearchOptions = { ...EMPTY_SEARCH_OPTIONS };

type SearchStreamHandler = (
  args: unknown,
  ctx: StreamContext,
) => AsyncGenerator<FileMatch[], SearchComplete, unknown>;

type SearchRunCommand =
  | { kind: "progress"; data: FileMatch[] }
  | { kind: "complete"; data: SearchComplete }
  | { kind: "error"; error: unknown };

class ControlledSearchRun {
  private readonly queued: SearchRunCommand[] = [];
  private readonly waiters: ((command: SearchRunCommand) => void)[] = [];

  next(signal: AbortSignal): Promise<SearchRunCommand> {
    if (signal.aborted) {
      return Promise.reject(createAbortError());
    }

    const queued = this.queued.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise<SearchRunCommand>((resolve, reject) => {
      let waiter!: (command: SearchRunCommand) => void;
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(createAbortError());
      };
      signal.addEventListener("abort", abort, { once: true });
      waiter = (command) => {
        signal.removeEventListener("abort", abort);
        resolve(command);
      };
      this.waiters.push(waiter);
    });
  }

  yield(batch: FileMatch[]): void {
    this.push({ kind: "progress", data: batch });
  }

  complete(complete: SearchComplete): void {
    this.push({ kind: "complete", data: complete });
  }

  fail(error: unknown): void {
    this.push({ kind: "error", error });
  }

  private push(command: SearchRunCommand): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(command);
      return;
    }
    this.queued.push(command);
  }
}

beforeEach(() => {
  resetInMemoryIpc();
  resetSearchStore();
});

afterEach(() => {
  resetSearchStore();
  resetInMemoryIpc();
});

describe("renderer search round-trip", () => {
  test("Scenario B: concurrent start aborts prior stream and ignores stale progress", async () => {
    const runs: ControlledSearchRun[] = [];
    await registerControlledSearch(runs);
    const pair = createIpcPair();
    installWindowForPair(pair);

    useSearchStore.getState().startSearch(WS_A, "first", BASE_OPTIONS);
    await waitFor(() => runs.length === 1, "expected first controlled stream");
    await waitFor(() => pair.streamStartCalls.length === 1, "expected first stream id");
    const firstStreamId = pair.streamStartCalls[0].result.streamId;
    await waitFor(
      () => pair.sender.hasStreamListener(firstStreamId),
      "expected first stream listener",
    );

    useSearchStore.getState().startSearch(WS_A, "second", BASE_OPTIONS);
    await waitFor(() => runs.length === 2, "expected second controlled stream");
    await waitFor(() => pair.streamStartCalls.length === 2, "expected second stream id");

    pair.sender.send("ipc:streamEvent", {
      streamId: firstStreamId,
      kind: "progress",
      data: fileBatch("stale.ts", "stale needle"),
    });
    runs[1].yield(fileBatch("fresh.ts", "fresh needle"));
    runs[1].complete({ filesScanned: 1, matchesFound: 1, limitHit: false, elapsedMs: 1 });
    await waitForSessionStatus(WS_A, "done");

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.query).toBe("second");
    expect(session.results.map((group) => group.relPath)).toEqual(["fresh.ts"]);
    expect(session.matchesFound).toBe(1);
  });

  test("Scenario C: abort leaves partial results and sets status idle", async () => {
    const runs: ControlledSearchRun[] = [];
    await registerControlledSearch(runs);
    const pair = createIpcPair();
    installWindowForPair(pair);

    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    await waitFor(() => runs.length === 1, "expected controlled stream");
    runs[0].yield(fileBatch("partial.ts", "partial needle"));
    await waitFor(
      () => useSearchStore.getState().sessions.get(WS_A)?.results.length === 1,
      "expected partial result",
    );

    useSearchStore.getState().cancelSearch(WS_A);

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.status).toBe("idle");
    expect(session.results.map((group) => group.relPath)).toEqual(["partial.ts"]);
    expect(session.matchesFound).toBe(1);
    expect(pair.sender.streamEvents.some((event) => event.kind === "error")).toBe(true);
  });

  test("Scenario D: sender targeting keeps one webContents pair from receiving another stream", async () => {
    const runs: ControlledSearchRun[] = [];
    await registerControlledSearch(runs);
    const pairA = createIpcPair();
    const pairB = createIpcPair();

    installWindowForPair(pairA);
    useSearchStore.getState().startSearch(WS_A, "alpha", BASE_OPTIONS);
    await waitFor(() => runs.length === 1, "expected first stream");
    await waitFor(() => pairA.streamStartCalls.length === 1, "expected first stream id");
    const streamA = pairA.streamStartCalls[0].result.streamId;
    await waitFor(() => pairA.sender.hasStreamListener(streamA), "expected pair A listener");

    installWindowForPair(pairB);
    useSearchStore.getState().startSearch(WS_B, "beta", BASE_OPTIONS);
    await waitFor(() => runs.length === 2, "expected second stream");
    await waitFor(() => pairB.streamStartCalls.length === 1, "expected second stream id");
    const streamB = pairB.streamStartCalls[0].result.streamId;
    await waitFor(() => pairB.sender.hasStreamListener(streamB), "expected pair B listener");

    runs[0].yield(fileBatch("only-a.ts", "alpha needle"));
    await waitFor(
      () => useSearchStore.getState().sessions.get(WS_A)?.results.length === 1,
      "expected pair A progress",
    );

    expect(pairA.sender.streamEvents.some((event) => event.streamId === streamA)).toBe(true);
    expect(pairB.sender.streamEvents.some((event) => event.streamId === streamA)).toBe(false);
    expect(useSearchStore.getState().sessions.get(WS_B)?.results).toEqual([]);

    runs[0].complete({ filesScanned: 1, matchesFound: 1, limitHit: false, elapsedMs: 1 });
    runs[1].complete({ filesScanned: 0, matchesFound: 0, limitHit: false, elapsedMs: 1 });
    await waitForSessionStatus(WS_A, "done");
    await waitForSessionStatus(WS_B, "done");
  });
});

async function registerControlledSearch(runs: ControlledSearchRun[]): Promise<void> {
  const router = await setupInMemoryRouter();
  router.register("fs", {
    call: {},
    listen: { changed: {} },
    stream: {
      searchText: async function* controlledSearch(
        _args: unknown,
        ctx: StreamContext,
      ): AsyncGenerator<FileMatch[], SearchComplete, unknown> {
        const run = new ControlledSearchRun();
        runs.push(run);
        while (true) {
          const command = await run.next(ctx.signal);
          if (command.kind === "progress") {
            yield command.data;
            continue;
          }
          if (command.kind === "error") {
            throw command.error;
          }
          return command.data;
        }
      } as SearchStreamHandler,
    },
  } as never);
}

function resetSearchStore(): void {
  useSearchStore.getState().closeAllForWorkspace(WS_A);
  useSearchStore.getState().closeAllForWorkspace(WS_B);
  useSearchStore.setState({ sessions: new Map() });
}

async function waitForSessionStatus(workspaceId: string, status: string): Promise<void> {
  await waitFor(
    () => useSearchStore.getState().sessions.get(workspaceId)?.status === status,
    `expected ${workspaceId} session status ${status}`,
  );
}

function fileBatch(relPath: string, preview: string): FileMatch[] {
  return [
    {
      relPath,
      matches: [{ range: { line: 0, startCol: 0, endCol: 6 }, preview }],
    },
  ];
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
