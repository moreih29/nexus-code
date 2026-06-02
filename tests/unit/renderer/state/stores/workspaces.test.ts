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

describe("workspaces store — connection status", () => {
  beforeEach(resetStore);

  test("listens to workspace.connectionChanged and stores status by workspace id", () => {
    emitWorkspaceEvent("connectionChanged", {
      workspaceId: WORKSPACE_ID,
      status: "connected",
    });

    expect(useWorkspacesStore.getState().connectionStatusByWorkspaceId[WORKSPACE_ID]).toBe(
      "connected",
    );
  });

  test("normalizes disconnected lifecycle events to idle display status", () => {
    emitWorkspaceEvent("connectionChanged", {
      workspaceId: WORKSPACE_ID,
      status: "disconnected",
    });

    expect(useWorkspacesStore.getState().connectionStatusByWorkspaceId[WORKSPACE_ID]).toBe("idle");
  });

  test("remove clears workspace connection status", () => {
    const workspace = makeWorkspace();
    useWorkspacesStore.getState().setAll([workspace]);
    useWorkspacesStore.getState().setConnectionStatus(WORKSPACE_ID, "connected");

    useWorkspacesStore.getState().remove(WORKSPACE_ID);

    expect(useWorkspacesStore.getState().connectionStatusByWorkspaceId[WORKSPACE_ID]).toBe(
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// upsert — sort-field change detection
// ---------------------------------------------------------------------------

describe("workspaces store — upsert sort-field detection", () => {
  const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  beforeEach(resetStore);

  it("updates in-place when sort fields are unchanged (hot path)", () => {
    const ws = makeWsWithOrder(ID_A, 1024);
    useWorkspacesStore.getState().setAll([ws]);

    const updated = { ...ws, name: "renamed" }; // same sortOrder
    useWorkspacesStore.getState().upsert(updated);

    const result = useWorkspacesStore.getState().workspaces;
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("renamed");
    expect(result[0].sortOrder).toBe(1024);
  });

  it("re-positions the item when sortOrder changes", () => {
    const a = makeWsWithOrder(ID_A, 3072);
    const b = makeWsWithOrder(ID_B, 1024);
    useWorkspacesStore.getState().setAll([b, a]); // b first (lower order)

    // Move a to position 512 (before b)
    const moved = { ...a, sortOrder: 512 };
    useWorkspacesStore.getState().upsert(moved);

    const ids = useWorkspacesStore.getState().workspaces.map((w) => w.id);
    expect(ids[0]).toBe(ID_A); // a moved to front
    expect(ids[1]).toBe(ID_B);
  });

  it("re-positions when pinned changes (cross-group)", () => {
    const a = makeWsWithOrder(ID_A, 1024);
    useWorkspacesStore.getState().setAll([a]);

    const pinned = { ...a, pinned: true, pinnedSortOrder: 1024, sortOrder: 0 };
    useWorkspacesStore.getState().upsert(pinned);

    const ws = useWorkspacesStore.getState().workspaces[0];
    expect(ws.pinned).toBe(true);
    expect(ws.pinnedSortOrder).toBe(1024);
  });
});

// ---------------------------------------------------------------------------
// reorder action
// ---------------------------------------------------------------------------

describe("workspaces store — reorder action", () => {
  const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  beforeEach(resetStore);

  it("patches sort fields for multiple rows and re-sorts the array", () => {
    const a = makeWsWithOrder(ID_A, 100);
    const b = makeWsWithOrder(ID_B, 101); // collapsed gap
    const c = makeWsWithOrder(ID_C, 102);
    useWorkspacesStore.getState().setAll([a, b, c]);

    // Simulate a rebalance: reassign step-1024 positions
    useWorkspacesStore.getState().reorder([
      { id: ID_A, sortOrder: 1024, pinnedSortOrder: 0, pinned: false },
      { id: ID_B, sortOrder: 2048, pinnedSortOrder: 0, pinned: false },
      { id: ID_C, sortOrder: 3072, pinnedSortOrder: 0, pinned: false },
    ]);

    const list = useWorkspacesStore.getState().workspaces;
    expect(list[0].id).toBe(ID_A);
    expect(list[0].sortOrder).toBe(1024);
    expect(list[1].id).toBe(ID_B);
    expect(list[1].sortOrder).toBe(2048);
    expect(list[2].id).toBe(ID_C);
    expect(list[2].sortOrder).toBe(3072);
  });

  it("re-sorts correctly when reorder changes relative positions", () => {
    const a = makeWsWithOrder(ID_A, 1024);
    const b = makeWsWithOrder(ID_B, 2048);
    useWorkspacesStore.getState().setAll([a, b]);

    // Swap positions
    useWorkspacesStore.getState().reorder([
      { id: ID_A, sortOrder: 3072, pinnedSortOrder: 0, pinned: false },
      { id: ID_B, sortOrder: 1024, pinnedSortOrder: 0, pinned: false },
    ]);

    const ids = useWorkspacesStore.getState().workspaces.map((w) => w.id);
    expect(ids[0]).toBe(ID_B); // b now first
    expect(ids[1]).toBe(ID_A);
  });

  it("pinned rows end up before unpinned rows after reorder patches", () => {
    const a = makeWsWithOrder(ID_A, 1024);
    const b = makeWsWithOrder(ID_B, 2048);
    useWorkspacesStore.getState().setAll([a, b]);

    // Make a pinned via reorder
    useWorkspacesStore.getState().reorder([
      { id: ID_A, sortOrder: 0, pinnedSortOrder: 1024, pinned: true },
    ]);

    const list = useWorkspacesStore.getState().workspaces;
    expect(list[0].id).toBe(ID_A);
    expect(list[0].pinned).toBe(true);
    expect(list[1].id).toBe(ID_B);
  });
});

// ---------------------------------------------------------------------------
// workspace.reordered event subscription
// ---------------------------------------------------------------------------

describe("workspaces store — workspace.reordered event", () => {
  const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
  const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01";

  beforeEach(() => {
    useWorkspacesStore.setState({ workspaces: [], connectionStatusByWorkspaceId: {} });
  });

  it("applies bulk position updates when workspace.reordered is emitted", () => {
    const a = makeWsWithOrder(ID_A, 100);
    const b = makeWsWithOrder(ID_B, 101);
    useWorkspacesStore.getState().setAll([a, b]);

    emitWorkspaceEvent("reordered", {
      orders: [
        { id: ID_A, sortOrder: 1024, pinnedSortOrder: 0, pinned: false },
        { id: ID_B, sortOrder: 2048, pinnedSortOrder: 0, pinned: false },
      ],
    });

    const list = useWorkspacesStore.getState().workspaces;
    expect(list[0].sortOrder).toBe(1024);
    expect(list[1].sortOrder).toBe(2048);
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
    const refreshed = [
      makeWsWithOrder(ID_A, 1024),
      makeWsWithOrder(ID_B, 2048),
    ];
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

// ---------------------------------------------------------------------------
// workspace.connectionProgress 이벤트 구독 및 상태 관리
// ---------------------------------------------------------------------------

describe("workspaces store — connection progress", () => {
  beforeEach(resetStore);

  test("stores progress event by workspaceId on connectionProgress", () => {
    emitWorkspaceEvent("connectionProgress", {
      workspaceId: WORKSPACE_ID,
      name: "nexus-agent",
      phase: "uploading",
      bytesTotal: 8_388_608,
    });

    const progress = useWorkspacesStore.getState().connectionProgressByWorkspaceId[WORKSPACE_ID];
    expect(progress?.phase).toBe("uploading");
    expect(progress?.name).toBe("nexus-agent");
    expect(progress?.bytesTotal).toBe(8_388_608);
  });

  test("overwrites previous progress event with latest", () => {
    emitWorkspaceEvent("connectionProgress", {
      workspaceId: WORKSPACE_ID,
      name: "nexus-agent",
      phase: "uploading",
    });
    emitWorkspaceEvent("connectionProgress", {
      workspaceId: WORKSPACE_ID,
      name: "nexus-agent",
      phase: "verifying",
    });

    const progress = useWorkspacesStore.getState().connectionProgressByWorkspaceId[WORKSPACE_ID];
    expect(progress?.phase).toBe("verifying");
  });

  test("clears progress entry when connectionChanged arrives with a terminal status", () => {
    emitWorkspaceEvent("connectionProgress", {
      workspaceId: WORKSPACE_ID,
      name: "nexus-agent",
      phase: "uploading",
    });
    // 연결 완료 → terminal 상태 → progress가 undefined로 클리어되어야 한다.
    emitWorkspaceEvent("connectionChanged", {
      workspaceId: WORKSPACE_ID,
      status: "connected",
    });

    const progress = useWorkspacesStore.getState().connectionProgressByWorkspaceId[WORKSPACE_ID];
    expect(progress).toBeUndefined();
  });

  test("does not clear progress when connectionChanged arrives with connecting status", () => {
    emitWorkspaceEvent("connectionProgress", {
      workspaceId: WORKSPACE_ID,
      name: "nexus-agent",
      phase: "checking",
    });
    emitWorkspaceEvent("connectionChanged", {
      workspaceId: WORKSPACE_ID,
      status: "connecting",
    });

    const progress = useWorkspacesStore.getState().connectionProgressByWorkspaceId[WORKSPACE_ID];
    expect(progress?.phase).toBe("checking");
  });

  test("clears progress on error terminal status", () => {
    emitWorkspaceEvent("connectionProgress", {
      workspaceId: WORKSPACE_ID,
      name: "nexus-agent",
      phase: "uploading",
    });
    emitWorkspaceEvent("connectionChanged", {
      workspaceId: WORKSPACE_ID,
      status: "error",
    });

    const progress = useWorkspacesStore.getState().connectionProgressByWorkspaceId[WORKSPACE_ID];
    expect(progress).toBeUndefined();
  });
});
