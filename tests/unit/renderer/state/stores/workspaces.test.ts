import { beforeEach, describe, expect, it, test } from "bun:test";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

type ListenerRecord = {
  channel: string;
  event: string;
  callback: (args: unknown) => void;
};

const listeners: ListenerRecord[] = [];
const { createWorkspacesStore } = await import(
  "../../../../../src/renderer/state/stores/workspaces"
);
const useWorkspacesStore = createWorkspacesStore({
  canUseIpcBridge: () => true,
  listen: (channel, event, callback) => {
    listeners.push({
      channel,
      event,
      callback: callback as (args: unknown) => void,
    });
    return () => {};
  },
});

const WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";

/**
 * Builds the minimum workspace metadata needed by the workspaces store tests.
 */
function makeWorkspace(id = WORKSPACE_ID): WorkspaceMeta {
  return {
    id,
    name: "local",
    location: { kind: "local", rootPath: "/tmp/project" },
    rootPath: "/tmp/project",
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

/**
 * Delivers captured workspaces-store IPC events to their callbacks.
 */
function emitWorkspaceEvent(event: string, args: unknown): void {
  const matching = listeners.filter(
    (record) => record.channel === "workspace" && record.event === event,
  );
  if (matching.length === 0) {
    throw new Error(`workspace listener not registered: ${event}`);
  }
  for (const listener of matching) {
    listener.callback(args);
  }
}

/**
 * Resets mutable Zustand state between tests while preserving store actions.
 */
function resetStore(): void {
  useWorkspacesStore.setState({
    workspaces: [],
    connectionStatusByWorkspaceId: {},
    connectionProgressByWorkspaceId: {},
  });
}

/**
 * Builds workspace metadata with explicit sort fields.
 */
function makeWsWithOrder(
  id: string,
  sortOrder: number,
  opts: Partial<WorkspaceMeta> = {},
): WorkspaceMeta {
  return {
    ...makeWorkspace(id),
    sortOrder,
    pinnedSortOrder: 0,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// A separate store instance with an injectable fetchList for fallback tests.
// ---------------------------------------------------------------------------

const fetchListResults: WorkspaceMeta[][] = [];
let fetchListCallCount = 0;

const storeWithFetch = createWorkspacesStore({
  canUseIpcBridge: () => true,
  listen: (channel, event, callback) => {
    listeners.push({
      channel,
      event,
      callback: callback as (args: unknown) => void,
    });
    return () => {};
  },
  fetchList: async () => {
    fetchListCallCount += 1;
    return fetchListResults.shift() ?? [];
  },
});

function resetFetchStore(): void {
  storeWithFetch.setState({
    workspaces: [],
    connectionStatusByWorkspaceId: {},
    connectionProgressByWorkspaceId: {},
  });
  fetchListResults.length = 0;
  fetchListCallCount = 0;
}

describe("workspaces store — Windows roots", () => {
  beforeEach(resetStore);

  function makeWindowsWorkspace(): WorkspaceMeta {
    return {
      ...makeWorkspace(),
      location: { kind: "local", rootPath: "c:\\work\\demo" },
      rootPath: "c:\\work\\demo",
    };
  }

  function storedRoots(): unknown[] {
    return useWorkspacesStore
      .getState()
      .workspaces.map((w) => [w.rootPath, w.location.kind === "local" && w.location.rootPath]);
  }

  test("keeps local drive roots with forward slashes on every way in", () => {
    useWorkspacesStore.getState().setAll([makeWindowsWorkspace()]);
    expect(storedRoots()).toEqual([["C:/work/demo", "C:/work/demo"]]);

    resetStore();
    useWorkspacesStore.getState().upsert(makeWindowsWorkspace());
    expect(storedRoots()).toEqual([["C:/work/demo", "C:/work/demo"]]);

    resetStore();
    emitWorkspaceEvent("changed", makeWindowsWorkspace());
    expect(storedRoots()).toEqual([["C:/work/demo", "C:/work/demo"]]);
  });

  test("leaves POSIX roots unchanged", () => {
    const workspace = makeWorkspace();
    useWorkspacesStore.getState().setAll([workspace]);

    expect(useWorkspacesStore.getState().workspaces[0]).toBe(workspace);
  });
});

// ---------------------------------------------------------------------------
// inconsistency fallback — fetchList triggered on sort collision
// ---------------------------------------------------------------------------

describe("workspaces store — fetchList fallback on inconsistency", () => {
  const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10";
  const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb10";

  beforeEach(resetFetchStore);

  it("triggers fetchList when upsert detects a sort-key tie (stale store)", async () => {
    const a = makeWsWithOrder(ID_A, 2048);
    // b starts at a different sort position so it's already in the store as
    // an existing entry; then we re-upsert it at the same position as a to
    // simulate a missed rebalance broadcast (sort-key tie).
    const bInitial = makeWsWithOrder(ID_B, 3072);
    const bColliding = makeWsWithOrder(ID_B, 2048); // collides with a → stale
    storeWithFetch.getState().setAll([a, bInitial]);

    // Enqueue the refreshed list that fetchList should return
    const refreshed = [makeWsWithOrder(ID_A, 1024), makeWsWithOrder(ID_B, 2048)];
    fetchListResults.push(refreshed);

    // Upsert b with the colliding sort key — inconsistency detected → fetchList
    storeWithFetch.getState().upsert(bColliding);

    // Give the async fetchList a tick to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchListCallCount).toBe(1);
    // Store should now contain the refreshed list
    const ids = storeWithFetch.getState().workspaces.map((w) => w.id);
    expect(ids).toContain(ID_A);
    expect(ids).toContain(ID_B);
  });
});
