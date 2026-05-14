import { describe, expect, test } from "bun:test";
import {
  InvalidSearchPatternError,
  searchTextStream,
  WorkspaceNotFoundError,
} from "../../../../../../src/main/features/search/handlers";
import type { StreamContext } from "../../../../../../src/main/infra/ipc/router";
import type {
  FileMatch,
  SearchComplete,
  TextSearchQuery,
} from "../../../../../../src/shared/types/search";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174001";
const UNKNOWN_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function baseQuery(overrides: Partial<TextSearchQuery> & { pattern: string }): TextSearchQuery {
  return {
    isRegExp: false,
    isCaseSensitive: false,
    isWordMatch: false,
    includes: [],
    excludes: [],
    maxResults: 2000,
    maxFileSize: 5 * 1024 * 1024,
    ...overrides,
  };
}

type AgentEventCallback = (payload: unknown) => void;

interface FakeAgentProvider {
  kind: "local" | "ssh";
  callAgentMethod: (method: string, params?: unknown) => Promise<unknown>;
  onAgentEvent: (event: string, callback: AgentEventCallback) => () => void;
}

function makeManager(provider: FakeAgentProvider, workspaces: WorkspaceMeta[] = [makeWorkspace()]) {
  return {
    list: (): WorkspaceMeta[] => workspaces,
    requireContext: (workspaceId: string) => {
      if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
        throw new Error(`workspace not found: ${workspaceId}`);
      }
      return { fs: provider };
    },
  };
}

function makeWorkspace(id = VALID_UUID): WorkspaceMeta {
  return {
    id,
    name: "test-workspace",
    rootPath: "/workspace",
    location: { kind: "local", rootPath: "/workspace" },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

function makeAgentProvider(options: {
  batches?: FileMatch[][];
  complete?: SearchComplete;
  reject?: Error;
}): FakeAgentProvider {
  const listeners = new Map<string, Set<AgentEventCallback>>();
  return {
    kind: "local",
    async callAgentMethod(method, params) {
      if (method === "search.cancel") return {};
      if (method !== "search.text") throw new Error(`unexpected method: ${method}`);
      if (options.reject) throw options.reject;
      const searchId = (params as { searchId: string }).searchId;
      for (const batch of options.batches ?? []) {
        for (const callback of listeners.get("search.progress") ?? []) {
          callback({ searchId, batch });
        }
      }
      return (
        options.complete ?? {
          filesScanned: 0,
          matchesFound: 0,
          limitHit: false,
          elapsedMs: 1,
        }
      );
    },
    onAgentEvent(event, callback) {
      let callbacks = listeners.get(event);
      if (!callbacks) {
        callbacks = new Set();
        listeners.set(event, callbacks);
      }
      callbacks.add(callback);
      return () => callbacks?.delete(callback);
    },
  };
}

function context(signal: AbortSignal = new AbortController().signal): StreamContext {
  return { signal };
}

async function consumeSearch(
  generator: AsyncGenerator<FileMatch[], SearchComplete, unknown>,
): Promise<{ progress: FileMatch[][]; complete: SearchComplete }> {
  const progress: FileMatch[][] = [];

  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { progress, complete: next.value };
    }
    progress.push(next.value);
  }
}

describe("searchTextStream", () => {
  test("returns an empty completion and yields no progress when there are no matches", async () => {
    const handler = searchTextStream(
      makeManager(
        makeAgentProvider({
          complete: { filesScanned: 1, matchesFound: 0, limitHit: false, elapsedMs: 1 },
        }),
      ) as never,
    );
    const { progress, complete } = await consumeSearch(
      handler({ workspaceId: VALID_UUID, query: baseQuery({ pattern: "needle" }) }, context()),
    );

    expect(progress).toEqual([]);
    expect(complete.filesScanned).toBe(1);
    expect(complete.matchesFound).toBe(0);
    expect(complete.limitHit).toBe(false);
    expect(complete.elapsedMs).toEqual(expect.any(Number));
  });

  test("yields FileMatch[] batches and returns final search counts", async () => {
    const batches = Array.from({ length: 2 }, (_, batchIndex) =>
      Array.from({ length: 30 }, (_, i) => ({
        relPath: `file-${batchIndex * 30 + i}.ts`,
        matches: [{ range: { line: 0, startCol: 0, endCol: 6 }, preview: "needle" }],
      })),
    );
    const handler = searchTextStream(
      makeManager(
        makeAgentProvider({
          batches,
          complete: { filesScanned: 60, matchesFound: 60, limitHit: false, elapsedMs: 2 },
        }),
      ) as never,
    );
    const { progress, complete } = await consumeSearch(
      handler({ workspaceId: VALID_UUID, query: baseQuery({ pattern: "needle" }) }, context()),
    );

    const allMatches = progress.flat();
    const totalMatches = allMatches.reduce((sum, file) => sum + file.matches.length, 0);

    expect(progress).toHaveLength(2);
    expect(allMatches).toHaveLength(60);
    expect(totalMatches).toBe(60);
    expect(complete.filesScanned).toBe(60);
    expect(complete.matchesFound).toBe(60);
    expect(complete.limitHit).toBe(false);
    expect(complete.elapsedMs).toEqual(expect.any(Number));
  });

  test("throws AbortError when the stream signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const handler = searchTextStream(makeManager(makeAgentProvider({})) as never);
    const generator = handler(
      { workspaceId: VALID_UUID, query: baseQuery({ pattern: "needle" }) },
      context(ctrl.signal),
    );

    await expect(generator.next()).rejects.toThrow("aborted");
  });

  test("throws InvalidSearchPatternError for an invalid regex", async () => {
    const handler = searchTextStream(
      makeManager(
        makeAgentProvider({
          reject: new Error('Invalid search pattern "[invalid": missing closing ]'),
        }),
      ) as never,
    );
    const generator = handler(
      {
        workspaceId: VALID_UUID,
        query: baseQuery({ pattern: "[invalid", isRegExp: true }),
      },
      context(),
    );

    await expect(generator.next()).rejects.toBeInstanceOf(InvalidSearchPatternError);
  });

  test("throws WorkspaceNotFoundError for an unknown workspace", async () => {
    const handler = searchTextStream(makeManager(makeAgentProvider({})) as never);
    const generator = handler(
      { workspaceId: UNKNOWN_UUID, query: baseQuery({ pattern: "needle" }) },
      context(),
    );

    const err = await generator.next().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(WorkspaceNotFoundError);
    expect((err as WorkspaceNotFoundError).name).toBe("WorkspaceNotFoundError");
    expect((err as WorkspaceNotFoundError).workspaceId).toBe(UNKNOWN_UUID);
  });
});
