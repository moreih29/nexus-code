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
// Mock ipcCall before importing the store
// ---------------------------------------------------------------------------

const mockIpcCall = mock((_channel: string, _method: string, _args: unknown) =>
  Promise.resolve([]),
);

const mockIpcListen = mock(
  (_channel: string, _event: string, _cb: unknown) => () => {},
);

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCall: mockIpcCall,
  ipcListen: mockIpcListen,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { handleFsChanged, selectFlat, useFilesStore } from "../../../../src/renderer/state/stores/files";
import type { DirEntry } from "../../../../src/shared/types/fs";

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
  mockIpcCall.mockClear();
  mockIpcListen.mockClear();
}

function setupReaddir(responses: Map<string, DirEntry[]>) {
  mockIpcCall.mockImplementation(
    (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
      if (method === "readdir") {
        const key = args.relPath;
        return Promise.resolve(responses.get(key) ?? []);
      }
      // watch / unwatch calls resolve with undefined (void)
      return Promise.resolve(undefined);
    },
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: ensureRoot → root 노드 생성 + readdir 1회 호출
// ---------------------------------------------------------------------------

describe("Scenario 1: ensureRoot", () => {
  beforeEach(resetStore);

  it("creates root node and calls readdir exactly once", async () => {
    setupReaddir(new Map([["", [dirEntry("src", "dir"), dirEntry("package.json", "file")]]]));

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree).toBeDefined();
    expect(tree?.rootAbsPath).toBe(ROOT);
    expect(tree?.nodes.has(ROOT)).toBe(true);

    const rootNode = tree?.nodes.get(ROOT);
    expect(rootNode?.type).toBe("dir");
    expect(rootNode?.childrenLoaded).toBe(true);
    expect(rootNode?.children).toHaveLength(2);

    expect(mockIpcCall).toHaveBeenCalledWith("fs", "readdir", {
      workspaceId: WS_ID,
      relPath: "",
    });
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "",
    });
  });

  it("is a no-op if called again for the same workspaceId", async () => {
    setupReaddir(new Map([["", []]]));
    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    mockIpcCall.mockClear();

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    expect(mockIpcCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: toggleExpand(자식 dir) → readdir 호출 후 children 로드
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

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    await useFilesStore.getState().toggleExpand(WS_ID, srcAbs);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    const srcNode = tree?.nodes.get(srcAbs);
    expect(srcNode?.childrenLoaded).toBe(true);
    expect(srcNode?.children).toContain(indexAbs);
    expect(tree?.expanded.has(srcAbs)).toBe(true);

    const flat = selectFlat(useFilesStore.getState(), WS_ID);
    const paths = flat.map((i) => i.absPath);
    expect(paths).toContain(srcAbs);
    expect(paths).toContain(indexAbs);

    // expand calls watch with the dir's relPath
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "src",
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: toggleExpand 두번 → 닫힘, selectFlat 결과 축소
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

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    await useFilesStore.getState().toggleExpand(WS_ID, srcAbs);

    const flatExpanded = selectFlat(useFilesStore.getState(), WS_ID);
    expect(flatExpanded.length).toBeGreaterThan(2);

    await useFilesStore.getState().toggleExpand(WS_ID, srcAbs);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree?.expanded.has(srcAbs)).toBe(false);

    const flatCollapsed = selectFlat(useFilesStore.getState(), WS_ID);
    // root + src (collapsed) — index.ts should NOT appear
    const paths = flatCollapsed.map((i) => i.absPath);
    expect(paths).toContain(srcAbs);
    expect(paths).not.toContain(`${srcAbs}/index.ts`);

    // second toggle (collapse) calls unwatch
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "unwatch", {
      workspaceId: WS_ID,
      relPath: "src",
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: refresh → childrenLoaded=false → 재로드
// ---------------------------------------------------------------------------

describe("Scenario 4: refresh reloads", () => {
  beforeEach(resetStore);

  it("resets childrenLoaded and calls readdir again", async () => {
    setupReaddir(new Map([["", [dirEntry("a.txt", "file")]]]));

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);

    const before = useFilesStore.getState().trees.get(WS_ID);
    expect(before?.nodes.get(ROOT)?.childrenLoaded).toBe(true);

    mockIpcCall.mockClear();
    // Simulate file system change: new entry appears
    setupReaddir(new Map([["", [dirEntry("a.txt", "file"), dirEntry("b.txt", "file")]]]));

    await useFilesStore.getState().refresh(WS_ID);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    const after = useFilesStore.getState().trees.get(WS_ID);
    expect(after?.nodes.get(ROOT)?.childrenLoaded).toBe(true);
    expect(after?.nodes.get(ROOT)?.children).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: reveal → 중간 ancestor 모두 expand 상태
// ---------------------------------------------------------------------------

describe("Scenario 5: reveal expands ancestors", () => {
  beforeEach(resetStore);

  it("expands all ancestor dirs from root to target", async () => {
    const srcAbs = `${ROOT}/src`;
    const componentsAbs = `${ROOT}/src/components`;
    const buttonAbs = `${ROOT}/src/components/Button.tsx`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("components", "dir")]],
        ["src/components", [dirEntry("Button.tsx", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    await useFilesStore.getState().reveal(WS_ID, buttonAbs);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree?.expanded.has(ROOT)).toBe(true);
    expect(tree?.expanded.has(srcAbs)).toBe(true);
    expect(tree?.expanded.has(componentsAbs)).toBe(true);

    // Button.tsx should be loaded as a node
    expect(tree?.nodes.has(buttonAbs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: selectFlat 순서 — dir 먼저 + 이름 사전순
// ---------------------------------------------------------------------------

describe("Scenario 6: selectFlat ordering — dirs first then alphabetical", () => {
  beforeEach(resetStore);

  it("returns dirs before files, both groups sorted alphabetically", async () => {
    setupReaddir(
      new Map([
        [
          "",
          [
            dirEntry("zebra.txt", "file"),
            dirEntry("alpha.txt", "file"),
            dirEntry("src", "dir"),
            dirEntry("lib", "dir"),
          ],
        ],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);

    const flat = selectFlat(useFilesStore.getState(), WS_ID);
    // flat[0] is root itself
    const names = flat.slice(1).map((i) => i.node.name);

    expect(names[0]).toBe("lib");
    expect(names[1]).toBe("src");
    expect(names[2]).toBe("alpha.txt");
    expect(names[3]).toBe("zebra.txt");
  });

  it("assigns correct depth values", async () => {
    const srcAbs = `${ROOT}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    await useFilesStore.getState().toggleExpand(WS_ID, srcAbs);

    const flat = selectFlat(useFilesStore.getState(), WS_ID);
    const rootItem = flat.find((i) => i.absPath === ROOT);
    const srcItem = flat.find((i) => i.absPath === srcAbs);
    const indexItem = flat.find((i) => i.node.name === "index.ts");

    expect(rootItem?.depth).toBe(0);
    expect(srcItem?.depth).toBe(1);
    expect(indexItem?.depth).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: fs.changed handler — reload expanded dirs, mark stale collapsed
// ---------------------------------------------------------------------------

describe("Scenario 7: fs.changed handler", () => {
  beforeEach(resetStore);

  it("reloads expanded+loaded parent directory on changed event", async () => {
    const srcAbs = `${ROOT}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    await useFilesStore.getState().toggleExpand(WS_ID, srcAbs);

    mockIpcCall.mockClear();
    // Update readdir to return a new file
    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file"), dirEntry("new.ts", "file")]],
      ]),
    );

    handleFsChanged({
      workspaceId: WS_ID,
      changes: [{ relPath: "src/new.ts", kind: "added" }],
    });

    // Allow async loadChildren to complete
    await new Promise((r) => setTimeout(r, 0));

    expect(mockIpcCall).toHaveBeenCalledWith("fs", "readdir", {
      workspaceId: WS_ID,
      relPath: "src",
    });
  });

  it("marks parent stale (childrenLoaded=false) when directory is collapsed", async () => {
    const srcAbs = `${ROOT}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    await useFilesStore.getState().toggleExpand(WS_ID, srcAbs);
    // Collapse src
    await useFilesStore.getState().toggleExpand(WS_ID, srcAbs);

    const beforeTree = useFilesStore.getState().trees.get(WS_ID);
    expect(beforeTree?.expanded.has(srcAbs)).toBe(false);

    mockIpcCall.mockClear();

    handleFsChanged({
      workspaceId: WS_ID,
      changes: [{ relPath: "src/new.ts", kind: "added" }],
    });

    // Collapsed — no readdir call, just mark stale
    expect(mockIpcCall).not.toHaveBeenCalledWith("fs", "readdir", expect.anything());
    const afterTree = useFilesStore.getState().trees.get(WS_ID);
    expect(afterTree?.nodes.get(srcAbs)?.childrenLoaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: ensureRoot hydrates persisted expanded paths (ancestors-first)
// ---------------------------------------------------------------------------

describe("Scenario 8: ensureRoot hydrates persisted expanded paths", () => {
  beforeEach(resetStore);

  it("seeds expanded set from getExpanded and loads children for each", async () => {
    const srcAbs = `${ROOT}/src`;
    const componentsAbs = `${ROOT}/src/components`;

    mockIpcCall.mockImplementation(
      (channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
        if (method === "getExpanded") {
          return Promise.resolve({ relPaths: ["src", "src/components"] });
        }
        if (method === "readdir") {
          const responses: Record<string, DirEntry[]> = {
            "": [dirEntry("src", "dir")],
            src: [dirEntry("components", "dir")],
            "src/components": [dirEntry("Button.tsx", "file")],
          };
          return Promise.resolve(responses[args.relPath] ?? []);
        }
        return Promise.resolve(undefined);
      },
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    // Both dirs should be in the expanded set.
    expect(tree?.expanded.has(srcAbs)).toBe(true);
    expect(tree?.expanded.has(componentsAbs)).toBe(true);
    // Children should have been loaded.
    expect(tree?.nodes.get(srcAbs)?.childrenLoaded).toBe(true);
    expect(tree?.nodes.get(componentsAbs)?.childrenLoaded).toBe(true);
    // watch should have been called for each hydrated dir.
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "watch", { workspaceId: WS_ID, relPath: "src" });
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "src/components",
    });
  });

  it("proceeds gracefully when getExpanded throws (non-fatal)", async () => {
    mockIpcCall.mockImplementation(
      (_channel: string, method: string, _args: unknown) => {
        if (method === "getExpanded") {
          return Promise.reject(new Error("storage not open"));
        }
        if (method === "readdir") return Promise.resolve([]);
        return Promise.resolve(undefined);
      },
    );

    // Should not throw.
    await expect(useFilesStore.getState().ensureRoot(WS_ID, ROOT)).resolves.toBeUndefined();
    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree).toBeDefined();
    // Root still expanded.
    expect(tree?.expanded.has(ROOT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: ensureRoot 동시 호출 시 readdir이 1회만 발화
// ---------------------------------------------------------------------------

describe("Scenario 10: ensureRoot concurrent calls deduplicate", () => {
  beforeEach(resetStore);

  it("fires readdir exactly once when ensureRoot is called concurrently", async () => {
    setupReaddir(new Map([["", [dirEntry("src", "dir")]]]));

    // Fire two concurrent calls without awaiting the first
    await Promise.all([
      useFilesStore.getState().ensureRoot(WS_ID, ROOT),
      useFilesStore.getState().ensureRoot(WS_ID, ROOT),
    ]);

    const readdirCalls = mockIpcCall.mock.calls.filter(
      ([, method]) => method === "readdir",
    );
    expect(readdirCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: loadChildren 동시 호출 시 readdir이 1회만 발화
// ---------------------------------------------------------------------------

describe("Scenario 11: loadChildren concurrent calls deduplicate", () => {
  beforeEach(resetStore);

  it("fires readdir exactly once when loadChildren is called concurrently for the same path", async () => {
    setupReaddir(new Map([["", [dirEntry("a.txt", "file")]]]));

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    // Reset root node so it is not yet loaded (simulate a fresh path)
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

    mockIpcCall.mockClear();

    // Fire two concurrent loadChildren for the same path
    await Promise.all([
      useFilesStore.getState().loadChildren(WS_ID, ROOT),
      useFilesStore.getState().loadChildren(WS_ID, ROOT),
    ]);

    const readdirCalls = mockIpcCall.mock.calls.filter(
      ([, method]) => method === "readdir",
    );
    expect(readdirCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: ensureRoot hydrate — depth-grouped parallel readdir calls
// ---------------------------------------------------------------------------

describe("Scenario 12: ensureRoot hydrate parallel readdir", () => {
  beforeEach(resetStore);

  it("issues 1 + N readdir calls total when N dirs are in persisted expanded set", async () => {
    // 10 sibling dirs at depth-1: a0..a9
    const dirs = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const readdirResponses: Record<string, DirEntry[]> = {
      "": dirs.map((d) => dirEntry(d, "dir")),
    };
    for (const d of dirs) {
      readdirResponses[d] = [];
    }

    mockIpcCall.mockImplementation(
      (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
        if (method === "getExpanded") {
          return Promise.resolve({ relPaths: dirs });
        }
        if (method === "readdir") {
          return Promise.resolve(readdirResponses[args.relPath] ?? []);
        }
        return Promise.resolve(undefined);
      },
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);

    const readdirCalls = mockIpcCall.mock.calls.filter(([, m]) => m === "readdir");
    // 1 root readdir + 10 child readdirs = 11 total
    expect(readdirCalls).toHaveLength(11);
  });

  it("ancestors-first: depth-1 readdir completes before depth-2 readdir is issued", async () => {
    // Structure: root → a (depth 1) → a/b (depth 2)
    const callOrder: string[] = [];

    mockIpcCall.mockImplementation(
      (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
        if (method === "getExpanded") {
          return Promise.resolve({ relPaths: ["a", "a/b", "c"] });
        }
        if (method === "readdir") {
          callOrder.push(args.relPath);
          const responses: Record<string, DirEntry[]> = {
            "": [dirEntry("a", "dir"), dirEntry("c", "dir")],
            a: [dirEntry("b", "dir")],
            "a/b": [],
            c: [],
          };
          return Promise.resolve(responses[args.relPath] ?? []);
        }
        return Promise.resolve(undefined);
      },
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);

    // Root readdir ("") must come before "a" and "c".
    // "a" must come before "a/b" (depth-1 group completes before depth-2 starts).
    const rootIdx = callOrder.indexOf("");
    const aIdx = callOrder.indexOf("a");
    const cIdx = callOrder.indexOf("c");
    const abIdx = callOrder.indexOf("a/b");

    expect(rootIdx).toBeLessThan(aIdx);
    expect(rootIdx).toBeLessThan(cIdx);
    expect(aIdx).toBeLessThan(abIdx);
    expect(cIdx).toBeLessThan(abIdx);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: toggleExpand schedules setExpanded persist after 200ms
// ---------------------------------------------------------------------------

describe("Scenario 9: toggleExpand debounces setExpanded persist", () => {
  beforeEach(resetStore);

  it("calls setExpanded with current expanded relPaths after debounce delay", async () => {
    const srcAbs = `${ROOT}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_ID, ROOT);
    mockIpcCall.mockClear();

    // Re-install mock so setExpanded is tracked but other calls resolve cleanly.
    const setExpandedCalls: { workspaceId: string; relPaths: string[] }[] = [];
    mockIpcCall.mockImplementation(
      (_channel: string, method: string, args: { workspaceId: string; relPaths?: string[]; relPath?: string }) => {
        if (method === "setExpanded") {
          setExpandedCalls.push({ workspaceId: args.workspaceId, relPaths: args.relPaths ?? [] });
          return Promise.resolve(undefined);
        }
        if (method === "readdir") return Promise.resolve([dirEntry("index.ts", "file")]);
        return Promise.resolve(undefined);
      },
    );

    await useFilesStore.getState().toggleExpand(WS_ID, srcAbs);

    // Wait for debounce (200ms) to fire.
    await new Promise((r) => setTimeout(r, 250));

    expect(setExpandedCalls).toHaveLength(1);
    expect(setExpandedCalls[0].workspaceId).toBe(WS_ID);
    expect(setExpandedCalls[0].relPaths).toContain("src");
    // Root (empty relPath) should not be persisted.
    expect(setExpandedCalls[0].relPaths).not.toContain("");
  });
});
