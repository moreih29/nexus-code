/**
 * Integration: layout persistence — toSnapshot round-trip + hydrate + sanitize
 *
 * SCOPE
 * -----
 * Verifies that the layout + tabs stores can be serialized into a
 * WorkspaceLayoutSnapshot, validated with zod, and fully restored via
 * useLayoutStore.hydrate(). Also covers the sanitize edge-cases:
 *   - dangling tabIds are stripped
 *   - non-sole empty leaves are collapsed
 *   - sole empty leaf is preserved
 *
 * toSnapshot is a private helper in persistence.ts (not exported).
 * We reconstruct the same logic inline here so that tests remain
 * self-contained — any future export refactor that happens to make it
 * public would only simplify these tests, not break them.
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * Automated: store state → snapshot → zod parse → hydrate → restored state
 * Not automated: IPC write (debounce/flush), Electron storage round-trip
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so store modules load without DOM / Electron preload.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
  matchMedia: () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
};

/** Default IPC mock used by tests that do not exercise bootstrap hydration. */
const defaultIpcCall = (_channel?: string, _method?: string, _args?: unknown): Promise<unknown> =>
  Promise.resolve(undefined);
const mockIpcCall = mock(defaultIpcCall);

mock.module("../../src/renderer/ipc/client", () => ({
  ipcCall: mockIpcCall,
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { bootstrapAppState } from "../../src/renderer/bootstrap";
import { openOrRevealEditor } from "../../src/renderer/services/editor";
import { openTerminalTab } from "../../src/renderer/state/operations";
import { openOrRevealCommitTab } from "../../src/renderer/state/operations/tabs";
import { unregisterStatePersistence } from "../../src/renderer/state/persistence";
import { useLayoutStore } from "../../src/renderer/state/stores/layout";
import { allLeaves, findLeaf, sanitize } from "../../src/renderer/state/stores/layout/helpers";
import type { LayoutNode } from "../../src/renderer/state/stores/layout/types";
import type { Tab } from "../../src/renderer/state/stores/tabs";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";
import { AppStateSchema } from "../../src/shared/types/app-state";
import type { WorkspaceLayoutSnapshot } from "../../src/shared/types/layout";
import { WorkspaceLayoutSnapshotSchema } from "../../src/shared/types/layout";
import { TabMetaSchema } from "../../src/shared/types/tab";
import { WorkspaceMetaSchema } from "../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";

function resetStores() {
  unregisterStatePersistence();
  mockIpcCall.mockImplementation(defaultIpcCall);
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

afterEach(() => {
  unregisterStatePersistence();
  mockIpcCall.mockImplementation(defaultIpcCall);
});

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout slice not found for ${WS}`);
  return layout;
}

/**
 * Inline equivalent of persistence.ts toSnapshot().
 * Builds { root, activeGroupId, tabs } from live store state.
 */
function buildSnapshot(workspaceId: string): WorkspaceLayoutSnapshot | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const tabRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  if (!layout) return null;
  const tabs: Tab[] = Object.values(tabRecord);
  return {
    root: layout.root as unknown as WorkspaceLayoutSnapshot["root"],
    activeGroupId: layout.activeGroupId,
    tabs: tabs as unknown as WorkspaceLayoutSnapshot["tabs"],
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — toSnapshot produces a zod-parseable WorkspaceLayoutSnapshot
// ---------------------------------------------------------------------------

describe("Scenario 1: snapshot round-trip — buildSnapshot + zod parse passes", () => {
  beforeEach(resetStores);

  it("snapshot of a workspace with one terminal tab passes zod parse", () => {
    openTerminalTab(WS, "terminal", { cwd: "/home/user" });

    const snapshot = buildSnapshot(WS);
    expect(snapshot).not.toBeNull();

    const result = WorkspaceLayoutSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("snapshot of a workspace with one editor tab passes zod parse", () => {
    openOrRevealEditor({ workspaceId: WS, filePath: "/home/user/main.ts" });

    const snapshot = buildSnapshot(WS);
    const result = WorkspaceLayoutSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("snapshot contains the correct activeGroupId that exists in root", () => {
    openTerminalTab(WS, "terminal", { cwd: "/tmp" });

    const snapshot = buildSnapshot(WS);
    expect(snapshot).not.toBeNull();
    const leaves = allLeaves(snapshot!.root as unknown as LayoutNode);
    const leafIds = leaves.map((l) => l.id);
    expect(leafIds).toContain(snapshot!.activeGroupId);
  });

  it("JSON.stringify → JSON.parse → zod parse round-trip is lossless", () => {
    openTerminalTab(WS, "terminal", { cwd: "/roundtrip" });

    const snapshot = buildSnapshot(WS);
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);
    const result = WorkspaceLayoutSnapshotSchema.safeParse(parsed);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.activeGroupId).toBe(snapshot!.activeGroupId);
      expect(result.data.tabs.length).toBe(snapshot!.tabs.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — hydrate restores root and activeGroupId
// ---------------------------------------------------------------------------

describe("Scenario 2: hydrate restores layout from snapshot", () => {
  beforeEach(resetStores);

  it("root structure is restored after hydrate", () => {
    // Build a live layout
    openTerminalTab(WS, "terminal", { cwd: "/before" });
    const liveLayout = getLayout();
    const snapshot = buildSnapshot(WS)!;
    const knownIds = new Set(Object.keys(useTabsStore.getState().byWorkspace[WS] ?? {}));

    // Wipe the store and restore via hydrate
    useLayoutStore.setState({ byWorkspace: {} });
    useLayoutStore.getState().hydrate(WS, snapshot as any, knownIds);

    const restoredLayout = getLayout();
    expect(restoredLayout.root.kind).toBe(liveLayout.root.kind);
    expect(restoredLayout.root.id).toBe(liveLayout.root.id);
  });

  it("activeGroupId is restored after hydrate", () => {
    openTerminalTab(WS, "terminal", { cwd: "/before" });
    const liveLayout = getLayout();
    const snapshot = buildSnapshot(WS)!;
    const knownIds = new Set(Object.keys(useTabsStore.getState().byWorkspace[WS] ?? {}));

    useLayoutStore.setState({ byWorkspace: {} });
    useLayoutStore.getState().hydrate(WS, snapshot as any, knownIds);

    expect(getLayout().activeGroupId).toBe(liveLayout.activeGroupId);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — dangling tabIds are stripped by sanitize during hydrate
// ---------------------------------------------------------------------------

describe("Scenario 3: dangling tabIds stripped during hydrate", () => {
  beforeEach(resetStores);

  it("tabId not in knownTabIds is removed from leaf after hydrate", () => {
    const danglingTabId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

    // Craft a snapshot with a leaf that has a dangling tabId
    openTerminalTab(WS, "terminal", { cwd: "/clean" });
    const layout = getLayout();
    const leafId = layout.activeGroupId;

    // Manually inject a dangling id into the snapshot root
    const leafCopy = { ...findLeaf(layout.root, leafId)!, tabIds: [danglingTabId] };
    const fakeRoot = { ...leafCopy } as LayoutNode;
    const fakeSnapshot = {
      root: fakeRoot,
      activeGroupId: leafId,
      tabs: [],
    };

    // Known tab ids is empty — dangling id should be stripped
    useLayoutStore.getState().hydrate(WS, fakeSnapshot as any, new Set<string>());

    const restoredLayout = getLayout();
    const allLeafList = allLeaves(restoredLayout.root);
    const allTabIds = allLeafList.flatMap((l) => l.tabIds);
    expect(allTabIds).not.toContain(danglingTabId);
  });

  it("sanitize helper strips dangling ids from a multi-leaf tree", () => {
    const goodId = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const badId = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
    const leaf1Id = "ffffffff-ffff-4fff-ffff-ffffffffffff";
    const leaf2Id = "11111111-1111-4111-b111-111111111111";

    const root: LayoutNode = {
      kind: "split",
      id: "22222222-2222-4222-b222-222222222222",
      orientation: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", id: leaf1Id, tabIds: [goodId], activeTabId: goodId },
      second: { kind: "leaf", id: leaf2Id, tabIds: [badId], activeTabId: badId },
    };

    // Only goodId is "known"
    const sanitized = sanitize(root, new Set([goodId]));

    // leaf2 becomes empty → it should be hoisted away (non-sole leaf)
    const leaves = allLeaves(sanitized);
    // After hoist, only leaf1 with goodId remains
    expect(leaves.length).toBe(1);
    expect(leaves[0]!.tabIds).toEqual([goodId]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — non-sole empty leaf in snapshot is collapse-hoisted
// ---------------------------------------------------------------------------

describe("Scenario 4: non-sole empty leaf collapsed during hydrate", () => {
  beforeEach(resetStores);

  it("snapshot with a non-sole empty leaf produces a simpler tree after hydrate", () => {
    const goodTabId = "aaaaaaaa-1111-4aaa-aaaa-aaaaaaaaaaaa";
    const emptyLeafId = "bbbbbbbb-1111-4bbb-bbbb-bbbbbbbbbbbb";
    const goodLeafId = "cccccccc-1111-4ccc-cccc-cccccccccccc";

    const splitRoot: LayoutNode = {
      kind: "split",
      id: "dddddddd-1111-4ddd-dddd-dddddddddddd",
      orientation: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", id: goodLeafId, tabIds: [goodTabId], activeTabId: goodTabId },
      second: { kind: "leaf", id: emptyLeafId, tabIds: [], activeTabId: null },
    };

    const snapshot = {
      root: splitRoot,
      activeGroupId: goodLeafId,
      tabs: [],
    };

    // goodTabId is known; emptyLeaf has no tabs → should be hoisted away
    useLayoutStore.getState().hydrate(WS, snapshot as any, new Set([goodTabId]));

    const layout = getLayout();
    // After hoist the root should be a single leaf
    expect(layout.root.kind).toBe("leaf");
    expect(layout.root.id).toBe(goodLeafId);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — sole empty leaf snapshot is preserved, activeGroupId is set
// ---------------------------------------------------------------------------

describe("Scenario 5: sole empty leaf preserved after hydrate", () => {
  beforeEach(resetStores);

  it("sole empty leaf root is preserved as-is (not removed)", () => {
    const emptyLeafId = "eeeeeeee-1111-4eee-eeee-eeeeeeeeeeee";

    const soleLeafRoot: LayoutNode = {
      kind: "leaf",
      id: emptyLeafId,
      tabIds: [],
      activeTabId: null,
    };

    const snapshot = {
      root: soleLeafRoot,
      activeGroupId: emptyLeafId,
      tabs: [],
    };

    useLayoutStore.getState().hydrate(WS, snapshot as any, new Set<string>());

    const layout = getLayout();
    expect(layout.root.kind).toBe("leaf");
    expect(layout.root.id).toBe(emptyLeafId);
    expect((layout.root as any).tabIds.length).toBe(0);
  });

  it("activeGroupId points to the sole leaf id after hydrate", () => {
    const emptyLeafId = "ffffffff-1111-4fff-ffff-ffffffffffff";

    const soleLeafRoot: LayoutNode = {
      kind: "leaf",
      id: emptyLeafId,
      tabIds: [],
      activeTabId: null,
    };

    const snapshot = {
      root: soleLeafRoot,
      activeGroupId: emptyLeafId,
      tabs: [],
    };

    useLayoutStore.getState().hydrate(WS, snapshot as any, new Set<string>());

    expect(getLayout().activeGroupId).toBe(emptyLeafId);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — full JSON round-trip is lossless across hydrate
// ---------------------------------------------------------------------------

describe("Scenario 6: full JSON.stringify → parse → hydrate round-trip", () => {
  beforeEach(resetStores);

  it("multi-tab split layout survives JSON round-trip through hydrate", () => {
    // Build a richer layout: two leaves, two tabs each
    openTerminalTab(WS, "terminal", { cwd: "/left-a" });
    const leafAId = getLayout().activeGroupId;

    openTerminalTab(WS, "terminal", { cwd: "/left-b" }, { groupId: leafAId });

    const leafBId = useLayoutStore.getState().splitGroup(WS, leafAId, "horizontal", "after");

    openTerminalTab(WS, "terminal", { cwd: "/right-a" }, { groupId: leafBId });
    openTerminalTab(WS, "terminal", { cwd: "/right-b" }, { groupId: leafBId });

    const snapshotBefore = buildSnapshot(WS)!;
    const allTabIds = new Set(Object.keys(useTabsStore.getState().byWorkspace[WS] ?? {}));

    // JSON round-trip
    const json = JSON.stringify(snapshotBefore);
    const parsedRaw = JSON.parse(json);
    const zodResult = WorkspaceLayoutSnapshotSchema.safeParse(parsedRaw);
    expect(zodResult.success).toBe(true);

    // Wipe and hydrate from parsed snapshot
    useLayoutStore.setState({ byWorkspace: {} });
    useLayoutStore.getState().hydrate(WS, parsedRaw as any, allTabIds);

    const layoutAfter = getLayout();

    // Leaf count preserved
    const leavesAfter = allLeaves(layoutAfter.root);
    const leavesBefore = allLeaves(snapshotBefore.root as unknown as LayoutNode);
    expect(leavesAfter.length).toBe(leavesBefore.length);

    // Tab counts per leaf preserved
    const tabCountsBefore = leavesBefore.map((l) => l.tabIds.length).sort();
    const tabCountsAfter = leavesAfter.map((l) => l.tabIds.length).sort();
    expect(tabCountsAfter).toEqual(tabCountsBefore);

    // activeGroupId survives
    expect(layoutAfter.activeGroupId).toBe(snapshotBefore.activeGroupId);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — git.commit preview schema + bootstrap round-trip
// ---------------------------------------------------------------------------

describe("Scenario 7: git.commit preview metadata round-trip", () => {
  beforeEach(resetStores);

  it("WorkspaceMeta TabMeta JSON round-trip preserves git.commit isPreview", () => {
    const tabMeta = {
      id: "99999999-9999-4999-9999-999999999999",
      workspaceId: WS,
      type: "git.commit" as const,
      title: "commit abcdef1",
      sha: COMMIT_SHA,
      isPreview: true,
    };

    const workspace = WorkspaceMetaSchema.parse({
      id: WS,
      name: "repo",
      rootPath: "/repo",
      colorTone: "default",
      pinned: false,
      tabs: [tabMeta],
    });
    const reparsedTab = TabMetaSchema.parse(JSON.parse(JSON.stringify(workspace.tabs[0])));

    expect(reparsedTab).toEqual(tabMeta);
  });

  it("AppState layout JSON round-trip and bootstrap preserve a git.commit preview tab", async () => {
    const opened = openOrRevealCommitTab(WS, COMMIT_SHA);
    const snapshot = buildSnapshot(WS)!;
    const appState = AppStateSchema.parse({
      layoutByWorkspace: {
        [WS]: snapshot,
      },
    });
    const reparsedState = AppStateSchema.parse(JSON.parse(JSON.stringify(appState)));

    useTabsStore.setState({ byWorkspace: {} });
    useLayoutStore.setState({ byWorkspace: {} });
    mockIpcCall.mockImplementation((channel: string, method: string) => {
      if (channel === "appState" && method === "get") return Promise.resolve(reparsedState);
      return Promise.resolve(undefined);
    });

    await bootstrapAppState();

    const restoredTab = useTabsStore.getState().byWorkspace[WS]?.[opened.tabId];
    expect(restoredTab).toMatchObject({
      type: "git.commit",
      props: { workspaceId: WS, sha: COMMIT_SHA },
      isPreview: true,
      isPinned: false,
    });
    expect(restoredTab?.title).toBe(`commit ${COMMIT_SHA.slice(0, 7)}`);
    expect(findLeaf(getLayout().root, opened.groupId)?.tabIds).toContain(opened.tabId);
  });
});
