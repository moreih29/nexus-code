import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shims
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Mock ipcCall
// ---------------------------------------------------------------------------

const mockIpcCall = mock((_channel: string, _method: string, _args: unknown) =>
  Promise.resolve(undefined),
);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mockIpcCall,
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  ensureRoot,
  loadChildren,
  refresh,
  toggleExpand,
} from "../../../../../src/renderer/state/operations/files";
import { useFilesStore } from "../../../../../src/renderer/state/stores/files";
import type { DirEntry } from "../../../../../src/shared/types/fs";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const WS_ID = "00000000-0000-0000-0000-000000000002";
const ROOT = "/test/workspace";

function dirEntry(name: string, type: DirEntry["type"] = "file"): DirEntry {
  return { name, type };
}

function resetStore() {
  useFilesStore.setState({ trees: new Map(), activeAbsPath: new Map() });
  mockIpcCall.mockClear();
}

function setupReaddir(responses: Record<string, DirEntry[]>) {
  mockIpcCall.mockImplementation(
    (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
      if (method === "getExpanded") return Promise.resolve({ relPaths: [] });
      if (method === "readdir") return Promise.resolve(responses[args.relPath] ?? []);
      return Promise.resolve(undefined);
    },
  );
}

// ---------------------------------------------------------------------------
// ensureRoot
// ---------------------------------------------------------------------------

describe("ensureRoot: initializes tree and calls IPC", () => {
  beforeEach(resetStore);

  it("calls getExpanded then watch then readdir", async () => {
    setupReaddir({ "": [dirEntry("a.ts")] });

    await ensureRoot(WS_ID, ROOT);

    expect(mockIpcCall).toHaveBeenCalledWith("fs", "getExpanded", { workspaceId: WS_ID });
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "watch", { workspaceId: WS_ID, relPath: "" });
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "readdir", {
      workspaceId: WS_ID,
      relPath: "",
    });

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree?.rootAbsPath).toBe(ROOT);
    expect(tree?.nodes.get(ROOT)?.childrenLoaded).toBe(true);
  });

  it("does not issue IPC if tree already exists (idempotent)", async () => {
    setupReaddir({ "": [] });
    await ensureRoot(WS_ID, ROOT);
    mockIpcCall.mockClear();

    await ensureRoot(WS_ID, ROOT);
    expect(mockIpcCall).not.toHaveBeenCalled();
  });

  it("tolerates getExpanded rejection and still builds tree", async () => {
    mockIpcCall.mockImplementation((_ch: string, method: string) => {
      if (method === "getExpanded") return Promise.reject(new Error("ipc error"));
      if (method === "readdir") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await expect(ensureRoot(WS_ID, ROOT)).resolves.toBeUndefined();
    expect(useFilesStore.getState().trees.get(WS_ID)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// loadChildren
// ---------------------------------------------------------------------------

describe("loadChildren: calls readdir and updates store", () => {
  beforeEach(resetStore);

  it("marks loading, calls readdir, sets children on success", async () => {
    setupReaddir({ "": [dirEntry("src", "dir"), dirEntry("index.ts")] });
    await ensureRoot(WS_ID, ROOT);

    // Reset childrenLoaded to test loadChildren independently
    useFilesStore.setState((s) => {
      const t = s.trees.get(WS_ID);
      if (!t) return s;
      const nodes = new Map(t.nodes);
      const rootNode = nodes.get(ROOT);
      if (rootNode) nodes.set(ROOT, { ...rootNode, childrenLoaded: false, children: [] });
      const trees = new Map(s.trees);
      trees.set(WS_ID, { ...t, nodes, loading: new Set() });
      return { trees };
    });
    mockIpcCall.mockClear();
    setupReaddir({ "": [dirEntry("src", "dir"), dirEntry("index.ts")] });

    await loadChildren(WS_ID, ROOT);

    expect(mockIpcCall).toHaveBeenCalledWith("fs", "readdir", {
      workspaceId: WS_ID,
      relPath: "",
    });

    const updated = useFilesStore.getState().trees.get(WS_ID);
    expect(updated?.nodes.get(ROOT)?.childrenLoaded).toBe(true);
    expect(updated?.nodes.get(ROOT)?.children).toHaveLength(2);
    expect(updated?.loading.has(ROOT)).toBe(false);
  });

  it("stores error message on readdir failure", async () => {
    setupReaddir({ "": [] });
    await ensureRoot(WS_ID, ROOT);

    // Reset to unloaded and inject a failing readdir
    useFilesStore.setState((s) => {
      const t = s.trees.get(WS_ID);
      if (!t) return s;
      const nodes = new Map(t.nodes);
      const rootNode = nodes.get(ROOT);
      if (rootNode) nodes.set(ROOT, { ...rootNode, childrenLoaded: false, children: [] });
      const trees = new Map(s.trees);
      trees.set(WS_ID, { ...t, nodes, loading: new Set() });
      return { trees };
    });

    mockIpcCall.mockImplementation((_ch: string, method: string) => {
      if (method === "readdir") return Promise.reject(new Error("EACCES"));
      return Promise.resolve(undefined);
    });

    await loadChildren(WS_ID, ROOT);

    const t = useFilesStore.getState().trees.get(WS_ID);
    expect(t?.errors.get(ROOT)).toContain("EACCES");
    expect(t?.loading.has(ROOT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toggleExpand debounce
// ---------------------------------------------------------------------------

describe("toggleExpand: calls watch/unwatch and debounces setExpanded", () => {
  beforeEach(resetStore);

  it("calls watch on expand and unwatch on collapse", async () => {
    setupReaddir({ "": [dirEntry("lib", "dir")], lib: [] });
    await ensureRoot(WS_ID, ROOT);

    const libAbs = `${ROOT}/lib`;
    mockIpcCall.mockClear();

    await toggleExpand(WS_ID, libAbs);
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "lib",
    });

    mockIpcCall.mockClear();
    await toggleExpand(WS_ID, libAbs);
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "unwatch", {
      workspaceId: WS_ID,
      relPath: "lib",
    });
  });

  it("fires setExpanded after debounce", async () => {
    setupReaddir({ "": [dirEntry("lib", "dir")], lib: [] });
    await ensureRoot(WS_ID, ROOT);

    const libAbs = `${ROOT}/lib`;
    const setExpandedArgs: unknown[] = [];
    mockIpcCall.mockImplementation((_ch: string, method: string, args: unknown) => {
      if (method === "setExpanded") setExpandedArgs.push(args);
      return Promise.resolve(undefined);
    });

    await toggleExpand(WS_ID, libAbs);
    await new Promise((r) => setTimeout(r, 250));

    expect(setExpandedArgs).toHaveLength(1);
    const arg = setExpandedArgs[0] as { workspaceId: string; relPaths: string[] };
    expect(arg.workspaceId).toBe(WS_ID);
    expect(arg.relPaths).toContain("lib");
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe("refresh: reloads subtree via readdir", () => {
  beforeEach(resetStore);

  it("wipes subtree and re-issues readdir for root", async () => {
    setupReaddir({ "": [dirEntry("old.ts")] });
    await ensureRoot(WS_ID, ROOT);

    mockIpcCall.mockClear();
    setupReaddir({ "": [dirEntry("new.ts")] });

    await refresh(WS_ID);

    expect(mockIpcCall).toHaveBeenCalledWith("fs", "readdir", {
      workspaceId: WS_ID,
      relPath: "",
    });
    const t = useFilesStore.getState().trees.get(WS_ID);
    expect(t?.nodes.get(ROOT)?.childrenLoaded).toBe(true);
    const childNames = t?.nodes
      .get(ROOT)
      ?.children.map((p) => t.nodes.get(p)?.name)
      .filter(Boolean);
    expect(childNames).toContain("new.ts");
  });
});
