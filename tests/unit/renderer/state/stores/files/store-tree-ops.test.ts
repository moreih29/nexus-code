import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shims — must run before any store import
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Mock ipcCallResult before importing the store
// ---------------------------------------------------------------------------

const mockIpcCallResult = mock((_channel: string, _method: string, _args: unknown) =>
  Promise.resolve({ ok: true as const, value: [] }),
);

const mockIpcListen = mock((_channel: string, _event: string, _cb: unknown) => () => {});

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mockIpcCallResult,
  ipcListen: mockIpcListen,
  canUseIpcBridge: () => false,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  ensureRoot,
  loadChildren,
  toggleExpand,
} from "../../../../../../src/renderer/state/operations/files";
import { selectFlat, useFilesStore } from "../../../../../../src/renderer/state/stores/files";
import type { DirEntry } from "../../../../../../src/shared/fs/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_ID = "00000000-0000-0000-0000-000000000001";
const ROOT = "/workspace/project";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dirEntry(name: string, type: DirEntry["type"] = "file"): DirEntry {
  return { name, type };
}

function resetStore() {
  useFilesStore.setState({ trees: new Map() });
  mockIpcCallResult.mockClear();
  mockIpcListen.mockClear();
}

function setupReaddir(responses: Map<string, DirEntry[]>) {
  mockIpcCallResult.mockImplementation(
    (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
      if (method === "readdir") {
        const key = args.relPath;
        return Promise.resolve({ ok: true as const, value: responses.get(key) ?? [] });
      }
      return Promise.resolve({ ok: true as const, value: undefined });
    },
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: ensureRoot → root node creation + readdir once
// ---------------------------------------------------------------------------

describe("Scenario 1: ensureRoot", () => {
  beforeEach(resetStore);

  it("creates root node and calls readdir exactly once", async () => {
    setupReaddir(new Map([["", [dirEntry("src", "dir"), dirEntry("package.json", "file")]]]));

    await ensureRoot(WS_ID, ROOT);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree).toBeDefined();
    expect(tree?.rootAbsPath).toBe(ROOT);
    expect(tree?.nodes.has(ROOT)).toBe(true);

    const rootNode = tree?.nodes.get(ROOT);
    expect(rootNode?.type).toBe("dir");
    expect(rootNode?.childrenLoaded).toBe(true);
    expect(rootNode?.children).toHaveLength(2);

    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "readdir", {
      workspaceId: WS_ID,
      relPath: "",
    });
    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "",
    });
  });

  it("is a no-op if called again for the same workspaceId", async () => {
    setupReaddir(new Map([["", []]]));
    await ensureRoot(WS_ID, ROOT);
    mockIpcCallResult.mockClear();

    await ensureRoot(WS_ID, ROOT);
    expect(mockIpcCallResult).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: toggleExpand(child dir) → readdir called, children loaded
// ---------------------------------------------------------------------------

describe("Scenario 2: toggleExpand child dir", () => {
  beforeEach(resetStore);

  it("loads grandchildren after expanding a child dir", async () => {
    const srcAbs = `${ROOT}/src`;
    const indexAbs = `${ROOT}/src/index.ts`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await ensureRoot(WS_ID, ROOT);
    await toggleExpand(WS_ID, srcAbs);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    const srcNode = tree?.nodes.get(srcAbs);
    expect(srcNode?.childrenLoaded).toBe(true);
    expect(srcNode?.children).toContain(indexAbs);
    expect(tree?.expanded.has(srcAbs)).toBe(true);

    const flat = selectFlat(useFilesStore.getState(), WS_ID);
    const paths = flat.map((i) => i.absPath);
    expect(paths).toContain(srcAbs);
    expect(paths).toContain(indexAbs);

    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "src",
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: toggleExpand twice → collapse, selectFlat shrinks
// ---------------------------------------------------------------------------

describe("Scenario 3: toggleExpand twice collapses", () => {
  beforeEach(resetStore);

  it("collapses after two toggles and selectFlat shrinks", async () => {
    const srcAbs = `${ROOT}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await ensureRoot(WS_ID, ROOT);
    await toggleExpand(WS_ID, srcAbs);

    const flatExpanded = selectFlat(useFilesStore.getState(), WS_ID);
    expect(flatExpanded.length).toBeGreaterThan(2);

    await toggleExpand(WS_ID, srcAbs);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree?.expanded.has(srcAbs)).toBe(false);

    const flatCollapsed = selectFlat(useFilesStore.getState(), WS_ID);
    const paths = flatCollapsed.map((i) => i.absPath);
    expect(paths).toContain(srcAbs);
    expect(paths).not.toContain(`${srcAbs}/index.ts`);

    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "unwatch", {
      workspaceId: WS_ID,
      relPath: "src",
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: ensureRoot concurrent calls deduplicate
// ---------------------------------------------------------------------------

describe("Scenario 10: ensureRoot concurrent calls deduplicate", () => {
  beforeEach(resetStore);

  it("fires readdir exactly once when ensureRoot is called concurrently", async () => {
    setupReaddir(new Map([["", [dirEntry("src", "dir")]]]));

    await Promise.all([ensureRoot(WS_ID, ROOT), ensureRoot(WS_ID, ROOT)]);

    const readdirCalls = mockIpcCallResult.mock.calls.filter(([, method]) => method === "readdir");
    expect(readdirCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: loadChildren concurrent calls deduplicate
// ---------------------------------------------------------------------------

describe("Scenario 11: loadChildren concurrent calls deduplicate", () => {
  beforeEach(resetStore);

  it("fires readdir exactly once when loadChildren is called concurrently for the same path", async () => {
    setupReaddir(new Map([["", [dirEntry("a.txt", "file")]]]));

    await ensureRoot(WS_ID, ROOT);
    useFilesStore.setState((state) => {
      const tree = state.trees.get(WS_ID);
      if (!tree) return state;
      const next = {
        ...tree,
        nodes: new Map(tree.nodes),
        loading: new Set<string>(),
      };
      const rootNode = next.nodes.get(ROOT);
      if (rootNode) {
        next.nodes.set(ROOT, { ...rootNode, childrenLoaded: false, children: [] });
      }
      const trees = new Map(state.trees);
      trees.set(WS_ID, next);
      return { trees };
    });

    mockIpcCallResult.mockClear();

    await Promise.all([loadChildren(WS_ID, ROOT), loadChildren(WS_ID, ROOT)]);

    const readdirCalls = mockIpcCallResult.mock.calls.filter(([, method]) => method === "readdir");
    expect(readdirCalls).toHaveLength(1);
  });
});
