import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

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
// Mock ipcCallResult
// ---------------------------------------------------------------------------

const mockIpcCallResult = mock((_channel: string, _method: string, _args: unknown) =>
  Promise.resolve({ ok: true as const, value: undefined }),
);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mockIpcCallResult,
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
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
import type { DirEntry } from "../../../../../src/shared/fs/types";

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
  mockIpcCallResult.mockClear();
}

function setupReaddir(responses: Record<string, DirEntry[]>) {
  mockIpcCallResult.mockImplementation(
    (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
      if (method === "getExpanded")
        return Promise.resolve({ ok: true as const, value: { relPaths: [] } });
      if (method === "readdir")
        return Promise.resolve({ ok: true as const, value: responses[args.relPath] ?? [] });
      return Promise.resolve({ ok: true as const, value: undefined });
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

    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "getExpanded", { workspaceId: WS_ID });
    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "",
    });
    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "readdir", {
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
    mockIpcCallResult.mockClear();

    await ensureRoot(WS_ID, ROOT);
    expect(mockIpcCallResult).not.toHaveBeenCalled();
  });

  it("tolerates getExpanded rejection and still builds tree", async () => {
    mockIpcCallResult.mockImplementation((_ch: string, method: string) => {
      if (method === "getExpanded") return Promise.reject(new Error("ipc error"));
      if (method === "readdir") return Promise.resolve({ ok: true as const, value: [] });
      return Promise.resolve({ ok: true as const, value: undefined });
    });

    await expect(ensureRoot(WS_ID, ROOT)).resolves.toBeUndefined();
    expect(useFilesStore.getState().trees.get(WS_ID)).toBeDefined();
  });

  it("prunes persisted rels whose fs.watch returns NOT_FOUND (stale-row cleanup)", async () => {
    // Scenario: previous session persisted three expanded paths. The user
    // deleted "stale" externally between sessions, so its watch fails
    // NOT_FOUND. "good" still exists. After ensureRoot completes, the
    // store must (a) drop "stale" from the in-memory expanded set and
    // (b) persist a setExpanded payload that excludes "stale".
    const setExpandedCalls: string[][] = [];

    mockIpcCallResult.mockImplementation(
      (
        _ch: string,
        method: string,
        args: { workspaceId: string; relPath?: string; relPaths?: string[] },
      ) => {
        if (method === "getExpanded") {
          return Promise.resolve({
            ok: true as const,
            value: { relPaths: ["good", "stale"] },
          });
        }
        if (method === "readdir") {
          // Root lists "good" (dir) but NOT "stale" — it was deleted on disk.
          if (args.relPath === "") {
            return Promise.resolve({
              ok: true as const,
              value: [{ name: "good", type: "dir" } as DirEntry],
            });
          }
          if (args.relPath === "good") {
            return Promise.resolve({ ok: true as const, value: [] });
          }
          return Promise.resolve({ ok: true as const, value: [] });
        }
        if (method === "watch") {
          if (args.relPath === "stale") {
            return Promise.resolve({
              ok: false as const,
              kind: "fs-error",
              message: "NOT_FOUND: /test/workspace/stale",
            });
          }
          return Promise.resolve({ ok: true as const, value: undefined });
        }
        if (method === "setExpanded") {
          setExpandedCalls.push(args.relPaths ?? []);
          return Promise.resolve({ ok: true as const, value: undefined });
        }
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    );

    await ensureRoot(WS_ID, ROOT);

    // In-memory: "stale" abs path is gone, "good" remains.
    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree?.expanded.has(`${ROOT}/stale`)).toBe(false);
    expect(tree?.expanded.has(`${ROOT}/good`)).toBe(true);

    // Persisted: at least one prune-time setExpanded fired and excludes "stale".
    expect(setExpandedCalls.length).toBeGreaterThan(0);
    const lastSave = setExpandedCalls[setExpandedCalls.length - 1];
    expect(lastSave).toContain("good");
    expect(lastSave).not.toContain("stale");
  });

  it("does NOT prune on non-NOT_FOUND watch failures (transient permission etc.)", async () => {
    // A PERMISSION_DENIED is a real failure but the file may exist —
    // pruning would silently drop user-requested state. Only NOT_FOUND
    // is the unambiguous "this is gone" signal.
    const setExpandedCalls: string[][] = [];

    mockIpcCallResult.mockImplementation(
      (
        _ch: string,
        method: string,
        args: { workspaceId: string; relPath?: string; relPaths?: string[] },
      ) => {
        if (method === "getExpanded") {
          return Promise.resolve({
            ok: true as const,
            value: { relPaths: ["locked"] },
          });
        }
        if (method === "readdir") {
          if (args.relPath === "") {
            return Promise.resolve({
              ok: true as const,
              value: [{ name: "locked", type: "dir" } as DirEntry],
            });
          }
          return Promise.resolve({ ok: true as const, value: [] });
        }
        if (method === "watch") {
          if (args.relPath === "locked") {
            return Promise.resolve({
              ok: false as const,
              kind: "fs-error",
              message: "PERMISSION_DENIED: /test/workspace/locked",
            });
          }
          return Promise.resolve({ ok: true as const, value: undefined });
        }
        if (method === "setExpanded") {
          setExpandedCalls.push(args.relPaths ?? []);
          return Promise.resolve({ ok: true as const, value: undefined });
        }
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    );

    await ensureRoot(WS_ID, ROOT);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree?.expanded.has(`${ROOT}/locked`)).toBe(true);
    // No prune-time setExpanded — only the (potentially zero) debounced
    // saves from earlier should appear. We assert no save was issued from
    // the prune branch by checking either nothing was saved or what was
    // saved still includes "locked".
    for (const save of setExpandedCalls) {
      expect(save).toContain("locked");
    }
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
    mockIpcCallResult.mockClear();
    setupReaddir({ "": [dirEntry("src", "dir"), dirEntry("index.ts")] });

    await loadChildren(WS_ID, ROOT);

    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "readdir", {
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

    mockIpcCallResult.mockImplementation((_ch: string, method: string) => {
      if (method === "readdir") return Promise.reject(new Error("EACCES"));
      return Promise.resolve({ ok: true as const, value: undefined });
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
    mockIpcCallResult.mockClear();

    await toggleExpand(WS_ID, libAbs);
    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "lib",
    });

    mockIpcCallResult.mockClear();
    await toggleExpand(WS_ID, libAbs);
    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "unwatch", {
      workspaceId: WS_ID,
      relPath: "lib",
    });
  });

  it("fires setExpanded after debounce", async () => {
    jest.useFakeTimers();
    try {
      setupReaddir({ "": [dirEntry("lib", "dir")], lib: [] });
      await ensureRoot(WS_ID, ROOT);

      const libAbs = `${ROOT}/lib`;
      const setExpandedArgs: unknown[] = [];
      mockIpcCallResult.mockImplementation((_ch: string, method: string, args: unknown) => {
        if (method === "setExpanded") setExpandedArgs.push(args);
        return Promise.resolve({ ok: true as const, value: undefined });
      });

      await toggleExpand(WS_ID, libAbs);
      jest.advanceTimersByTime(250);

      expect(setExpandedArgs).toHaveLength(1);
      const arg = setExpandedArgs[0] as { workspaceId: string; relPaths: string[] };
      expect(arg.workspaceId).toBe(WS_ID);
      expect(arg.relPaths).toContain("lib");
    } finally {
      jest.useRealTimers();
    }
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

    mockIpcCallResult.mockClear();
    setupReaddir({ "": [dirEntry("new.ts")] });

    await refresh(WS_ID);

    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "readdir", {
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
