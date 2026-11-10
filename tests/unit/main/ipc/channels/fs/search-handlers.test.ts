import { describe, expect, test } from "bun:test";
import { searchTextStream } from "../../../../../../src/main/features/search";
import type { StreamContext } from "../../../../../../src/main/infra/ipc-router";
import type {
  FileMatch,
  SearchComplete,
  TextSearchQuery,
} from "../../../../../../src/shared/search/types";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174001";

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
  onAgentLifecycle: (callback: (event: { type: string }) => void) => () => void;
}

function makeManager(provider: FakeAgentProvider, workspaces: WorkspaceMeta[] = [makeWorkspace()]) {
  const requireContext = (workspaceId: string) => {
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new Error(`workspace not found: ${workspaceId}`);
    }
    return { fs: provider };
  };
  return {
    list: (): WorkspaceMeta[] => workspaces,
    requireContext,
    getFs: async (workspaceId: string) => requireContext(workspaceId).fs,
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
    onAgentLifecycle: () => () => {},
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

  test("waits for the agent provider while the workspace is still starting", async () => {
    const provider = makeAgentProvider({
      complete: { filesScanned: 3, matchesFound: 0, limitHit: false, elapsedMs: 1 },
    });
    let resolveProvider!: (value: FakeAgentProvider) => void;
    const manager = {
      list: (): WorkspaceMeta[] => [makeWorkspace()],
      // The context still holds the inert placeholder until the agent boots.
      requireContext: () => ({ fs: {} }),
      getFs: () =>
        new Promise<FakeAgentProvider>((resolve) => {
          resolveProvider = resolve;
        }),
    };
    const handler = searchTextStream(manager as never);
    const search = consumeSearch(
      handler({ workspaceId: VALID_UUID, query: baseQuery({ pattern: "needle" }) }, context()),
    );
    await Promise.resolve();
    resolveProvider(provider);

    const { complete } = await search;
    expect(complete.filesScanned).toBe(3);
  });

  test("cancels the agent search when the request times out locally", async () => {
    const methods: string[] = [];
    const provider = makeAgentProvider({});
    provider.callAgentMethod = async (method) => {
      methods.push(method);
      if (method === "search.cancel") return {};
      throw new Error("search.text timed out after 30000ms");
    };
    const handler = searchTextStream(makeManager(provider) as never);

    await expect(
      consumeSearch(
        handler({ workspaceId: VALID_UUID, query: baseQuery({ pattern: "needle" }) }, context()),
      ),
    ).rejects.toThrow("timed out");
    expect(methods).toEqual(["search.text", "search.cancel"]);
  });
});
