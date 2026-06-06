import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamContext } from "../../src/main/infra/ipc-router";
import {
  EMPTY_SEARCH_OPTIONS,
  type SearchOptions,
  useSearchStore,
} from "../../src/renderer/state/stores/search";
import type { FileMatch, SearchComplete } from "../../src/shared/search/types";
import type { WorkspaceMeta } from "../../src/shared/types/workspace";
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

let tmpRoots: string[] = [];

beforeEach(() => {
  resetInMemoryIpc();
  resetSearchStore();
  tmpRoots = [];
});

afterEach(() => {
  resetSearchStore();
  resetInMemoryIpc();
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("renderer search round-trip", () => {
  test("Scenario A: real router/client/store search reports 3 result files and 4 matches", async () => {
    const root = makeTmpRoot();
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "one.ts"), "needle\nneedle again\n");
    fs.writeFileSync(path.join(root, "two.ts"), "prefix needle suffix\n");
    fs.writeFileSync(path.join(root, "nested", "three.ts"), "last needle\n");

    await registerRealSearch([{ id: WS_A, rootPath: root }]);
    const pair = createIpcPair();
    installWindowForPair(pair);

    useSearchStore.getState().startSearch(WS_A, "needle", BASE_OPTIONS);
    await waitForSessionStatus(WS_A, "done");

    const session = useSearchStore.getState().sessions.get(WS_A)!;
    expect(session.results.length).toBe(3);
    expect(session.matchesFound).toBe(4);
    expect(session.filesScanned).toBe(3);
    expect(totalMatches(session.results)).toBe(4);
  });

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

async function registerRealSearch(workspaces: { id: string; rootPath: string }[]): Promise<void> {
  const router = await setupInMemoryRouter();
  const { searchTextStream } = await import("../../src/main/features/search");
  const providers = new Map(
    workspaces.map(({ id, rootPath }) => [id, makeTestSearchProvider(rootPath)] as const),
  );
  router.register("fs", {
    call: {},
    listen: { changed: {} },
    stream: { searchText: searchTextStream(makeManager(workspaces, providers)) },
  } as never);
}

function makeTestSearchProvider(rootPath: string) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    kind: "local" as const,
    async callAgentMethod(method: string, params?: unknown) {
      if (method === "search.cancel") return {};
      if (method !== "search.text") throw new Error(`unexpected method: ${method}`);

      const { searchId, query } = params as { searchId: string; query: { pattern: string } };
      const batch: FileMatch[] = [];
      let matchesFound = 0;
      for (const relPath of listFiles(rootPath)) {
        const content = fs.readFileSync(path.join(rootPath, relPath), "utf8");
        const matches = content
          .split(/\r\n|\n|\r/)
          .flatMap((line, lineIndex) => {
            const out: FileMatch["matches"] = [];
            let start = line.indexOf(query.pattern);
            while (start >= 0) {
              out.push({
                range: { line: lineIndex, startCol: start, endCol: start + query.pattern.length },
                preview: line,
              });
              start = line.indexOf(query.pattern, start + query.pattern.length);
            }
            return out;
          });
        if (matches.length > 0) {
          matchesFound += matches.length;
          batch.push({ relPath, matches });
        }
      }
      for (const callback of listeners.get("search.progress") ?? []) {
        callback({ searchId, batch });
      }
      return { filesScanned: batch.length, matchesFound, limitHit: false, elapsedMs: 1 };
    },
    onAgentEvent(event: string, callback: (payload: unknown) => void) {
      let callbacks = listeners.get(event);
      if (!callbacks) {
        callbacks = new Set();
        listeners.set(event, callbacks);
      }
      callbacks.add(callback);
      return () => callbacks?.delete(callback);
    },
    onAgentLifecycle: () => () => {},
  };
}

function listFiles(rootPath: string, relDir = "."): string[] {
  const absDir = path.join(rootPath, relDir);
  const out: string[] = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = relDir === "." ? entry.name : path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(rootPath, relPath));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

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

function makeManager(workspaces: { id: string; rootPath: string }[], providers?: Map<string, unknown>) {
  return {
    list: (): WorkspaceMeta[] =>
      workspaces.map(({ id, rootPath }) => ({
        id,
        rootPath,
        location: { kind: "local", rootPath },
        name: path.basename(rootPath),
        colorTone: "default",
        pinned: false,
        lastOpenedAt: new Date().toISOString(),
        tabs: [],
      })),
    requireContext: (workspaceId: string) => {
      const provider = providers?.get(workspaceId);
      if (!provider) throw new Error(`workspace not found: ${workspaceId}`);
      return { fs: provider };
    },
  };
}

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-search-round-trip-"));
  tmpRoots.push(root);
  return root;
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

function totalMatches(groups: { matches: unknown[] }[]): number {
  return groups.reduce((sum, group) => sum + group.matches.length, 0);
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
