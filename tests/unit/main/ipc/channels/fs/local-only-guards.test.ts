import { describe, expect, it, mock } from "bun:test";
import { searchTextStream } from "../../../../../../src/main/features/search";
import {
  unwatchHandler,
  watchHandler,
} from "../../../../../../src/main/features/fs/ipc/watch-handlers";
import type { StreamContext } from "../../../../../../src/main/infra/ipc-router";
import type { TextSearchQuery } from "../../../../../../src/shared/search/types";
import type { WorkspaceMeta } from "../../../../../../src/shared/types/workspace";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174010";

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

function makeManager(workspaces: WorkspaceMeta[], provider: unknown) {
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

function makeSshWorkspace(remotePath: string): WorkspaceMeta {
  return {
    id: WORKSPACE_ID,
    name: "ssh-workspace",
    rootPath: remotePath,
    location: { kind: "ssh", host: "dev.example.com", remotePath },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

function context(signal: AbortSignal = new AbortController().signal): StreamContext {
  return { signal };
}

describe("fs agent-backed SSH workspace delegation", () => {
  it("runs search through the workspace agent provider", async () => {
    const workspace = makeSshWorkspace("/srv/repo");
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const provider = {
      kind: "ssh" as const,
      callAgentMethod: mock(async (method: string, params?: unknown) => {
        if (method !== "search.text") return {};
        const searchId = (params as { searchId: string }).searchId;
        for (const callback of listeners.get("search.progress") ?? []) {
          callback({
            searchId,
            batch: [
              {
                relPath: "remote.ts",
                matches: [{ range: { line: 0, startCol: 0, endCol: 6 }, preview: "needle" }],
              },
            ],
          });
        }
        return { filesScanned: 1, matchesFound: 1, limitHit: false, elapsedMs: 1 };
      }),
      onAgentEvent: (event: string, callback: (payload: unknown) => void) => {
        let callbacks = listeners.get(event);
        if (!callbacks) {
          callbacks = new Set();
          listeners.set(event, callbacks);
        }
        callbacks.add(callback);
        return () => callbacks?.delete(callback);
      },
    };
    const handler = searchTextStream(makeManager([workspace], provider) as never);
    const generator = handler(
      { workspaceId: WORKSPACE_ID, query: baseQuery({ pattern: "needle" }) },
      context(),
    );

    const progress = await generator.next();
    expect(progress.done).toBe(false);
    expect(progress.value?.[0]?.relPath).toBe("remote.ts");
    const complete = await generator.next();
    expect(complete.done).toBe(true);
    expect(complete.value.matchesFound).toBe(1);
    expect(provider.callAgentMethod).toHaveBeenCalledWith(
      "search.text",
      expect.objectContaining({ query: expect.objectContaining({ pattern: "needle" }) }),
    );
  });

  it("delegates watch and unwatch to the agent watcher", async () => {
    const watcher = {
      watch: mock(async (_workspaceId: string, _relPath: string) => {}),
      unwatch: mock(async (_workspaceId: string, _relPath: string) => {}),
    };

    await watchHandler(watcher as never)({
      workspaceId: WORKSPACE_ID,
      relPath: ".",
    });
    await unwatchHandler(watcher as never)({
      workspaceId: WORKSPACE_ID,
      relPath: ".",
    });

    expect(watcher.watch).toHaveBeenCalledWith(WORKSPACE_ID, ".");
    expect(watcher.unwatch).toHaveBeenCalledWith(WORKSPACE_ID, ".");
  });
});
