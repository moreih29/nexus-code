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

import { ensureRoot, loadChildren } from "../../../../../../src/renderer/state/operations/files";
import { useFilesStore } from "../../../../../../src/renderer/state/stores/files";
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
// Scenario 11: loadChildren concurrent calls coalesce
// ---------------------------------------------------------------------------

describe("Scenario 11: loadChildren concurrent calls coalesce", () => {
  beforeEach(resetStore);

  // A request that arrives while a readdir is in flight may reflect a change
  // newer than that read, so it is not dropped: all such requests collapse
  // into ONE follow-up read after the in-flight one settles.
  it("collapses concurrent calls into the in-flight readdir plus one follow-up", async () => {
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

    await Promise.all([
      loadChildren(WS_ID, ROOT),
      loadChildren(WS_ID, ROOT),
      loadChildren(WS_ID, ROOT),
    ]);

    const readdirCalls = mockIpcCallResult.mock.calls.filter(([, method]) => method === "readdir");
    expect(readdirCalls).toHaveLength(2);
  });
});
