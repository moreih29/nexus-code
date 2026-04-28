import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  SearchCancelCommand,
  SearchFailedEvent,
  SearchStartedReply,
  SearchStartCommand,
} from "../../../../shared/src/contracts/generated/search-lifecycle";
import type { SearchResultChunkMessage } from "../../../../shared/src/contracts/generated/search-relay";
import {
  SEARCH_RESULT_LIMIT,
  buildSearchOptions,
  createSearchStore,
  type SearchBridge,
  type SearchBridgeEvent,
} from "./search-store";

const workspaceId = "ws_search" as WorkspaceId;

class FakeSearchBridge implements SearchBridge {
  public readonly listeners = new Set<(event: SearchBridgeEvent) => void>();
  public startCommands: SearchStartCommand[] = [];
  public cancelCommands: SearchCancelCommand[] = [];
  public disposeCount = 0;

  async startSearch(command: SearchStartCommand): Promise<SearchStartedReply | SearchFailedEvent> {
    this.startCommands.push(command);
    const reply: SearchStartedReply = {
      type: "search/lifecycle",
      action: "started",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      sessionId: command.sessionId,
      ripgrepPath: "/usr/bin/rg",
      startedAt: "2026-04-28T01:00:00.000Z",
    };
    this.emit(reply);
    return reply;
  }

  async cancelSearch(command: SearchCancelCommand): Promise<void> {
    this.cancelCommands.push(command);
  }

  onEvent(listener: (event: SearchBridgeEvent) => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.disposeCount += 1;
        this.listeners.delete(listener);
      },
    };
  }

  emit(event: SearchBridgeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

describe("search-store", () => {
  test("starts a workspace search with generated contract options and history", async () => {
    const bridge = new FakeSearchBridge();
    const store = createSearchStore(bridge);

    store.getState().setQuery(workspaceId, "hello");
    store.getState().setIncludeText(workspaceId, "src/**, *.ts");
    store.getState().setExcludeText(workspaceId, "node_modules/**\ndist/**");
    store.getState().toggleOption(workspaceId, "caseSensitive");
    store.getState().toggleOption(workspaceId, "wholeWord");
    store.getState().startBridgeSubscription();

    await store.getState().startSearch({ workspaceId, cwd: "/repo" });

    expect(bridge.startCommands).toHaveLength(1);
    expect(bridge.startCommands[0]).toMatchObject({
      type: "search/lifecycle",
      action: "start",
      workspaceId,
      query: "hello",
      cwd: "/repo",
      options: {
        caseSensitive: true,
        regex: false,
        wholeWord: true,
        includeGlobs: ["src/**", "*.ts"],
        excludeGlobs: ["node_modules/**", "dist/**"],
        useGitIgnore: true,
      },
    });
    expect(store.getState().getWorkspaceState(workspaceId).status).toBe("running");
    expect(store.getState().getWorkspaceState(workspaceId).history).toEqual(["hello"]);
  });

  test("groups streamed results by file and enforces the 10k renderer limit", async () => {
    const bridge = new FakeSearchBridge();
    const store = createSearchStore(bridge);
    store.getState().setQuery(workspaceId, "foo");
    store.getState().startBridgeSubscription();
    await store.getState().startSearch({ workspaceId, cwd: "/repo" });
    const sessionId = bridge.startCommands[0]!.sessionId;

    bridge.emit(chunk(sessionId, [
      result("src/a.ts", 1),
      result("src/b.ts", 2),
      result("src/a.ts", 3),
    ]));

    expect(store.getState().getFileGroups(workspaceId).map((group) => [
      group.path,
      group.matches.map((match) => match.lineNumber),
    ])).toEqual([
      ["src/a.ts", [1, 3]],
      ["src/b.ts", [2]],
    ]);

    bridge.emit(chunk(sessionId, Array.from({ length: SEARCH_RESULT_LIMIT + 5 }, (_, index) =>
      result("src/many.ts", index + 10),
    )));

    const workspace = store.getState().getWorkspaceState(workspaceId);
    expect(workspace.matchCount).toBe(SEARCH_RESULT_LIMIT);
    expect(workspace.truncated).toBe(true);
  });

  test("cycles history and advances active match", async () => {
    const bridge = new FakeSearchBridge();
    const store = createSearchStore(bridge);
    store.getState().startBridgeSubscription();

    store.getState().setQuery(workspaceId, "first");
    await store.getState().startSearch({ workspaceId, cwd: "/repo" });
    store.getState().setQuery(workspaceId, "second");
    await store.getState().startSearch({ workspaceId, cwd: "/repo" });

    expect(store.getState().cycleHistory(workspaceId, "previous")).toBe("second");
    expect(store.getState().cycleHistory(workspaceId, "previous")).toBe("first");

    const sessionId = bridge.startCommands.at(-1)!.sessionId;
    bridge.emit(chunk(sessionId, [result("one.ts", 5), result("two.ts", 9)]));

    expect(store.getState().goToNextMatch(workspaceId)?.path).toBe("one.ts");
    expect(store.getState().getWorkspaceState(workspaceId).activeMatch?.lineNumber).toBe(5);
    expect(store.getState().goToNextMatch(workspaceId)?.path).toBe("two.ts");
  });

  test("search option builder splits comma and newline globs", () => {
    expect(buildSearchOptions({
      caseSensitive: false,
      regex: true,
      wholeWord: false,
      includeText: "src/**,test/**",
      excludeText: "dist/**\nnode_modules/**",
      useGitIgnore: true,
    })).toMatchObject({
      includeGlobs: ["src/**", "test/**"],
      excludeGlobs: ["dist/**", "node_modules/**"],
    });
  });
});

function chunk(sessionId: string, results: SearchResultChunkMessage["results"]): SearchResultChunkMessage {
  return {
    type: "search/relay",
    direction: "server_to_client",
    kind: "result_chunk",
    workspaceId,
    sessionId,
    seq: 1,
    results,
    truncated: false,
  };
}

function result(path: string, lineNumber: number): SearchResultChunkMessage["results"][number] {
  return {
    path,
    lineNumber,
    column: 4,
    lineText: "const foo = 1;",
    submatches: [{ start: 6, end: 9, match: "foo" }],
  };
}
