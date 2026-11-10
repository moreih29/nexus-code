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

import { ensureRoot } from "../../../../../../src/renderer/state/operations/files";
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

// ---------------------------------------------------------------------------
// Scenario 8: ensureRoot hydrates persisted expanded paths (ancestors-first)
// ---------------------------------------------------------------------------

describe("Scenario 8: ensureRoot hydrates persisted expanded paths", () => {
  beforeEach(resetStore);

  it("proceeds gracefully when getExpanded throws (non-fatal)", async () => {
    mockIpcCallResult.mockImplementation((_channel: string, method: string, _args: unknown) => {
      if (method === "getExpanded") {
        return Promise.reject(new Error("storage not open"));
      }
      if (method === "readdir") return Promise.resolve({ ok: true as const, value: [] });
      return Promise.resolve({ ok: true as const, value: undefined });
    });

    await expect(ensureRoot(WS_ID, ROOT)).resolves.toBeUndefined();
    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree).toBeDefined();
    expect(tree?.expanded.has(ROOT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: ensureRoot hydrate — depth-grouped parallel readdir calls
// ---------------------------------------------------------------------------

describe("Scenario 12: ensureRoot hydrate parallel readdir", () => {
  beforeEach(resetStore);

  it("ancestors-first: depth-1 readdir completes before depth-2 readdir is issued", async () => {
    const callOrder: string[] = [];

    mockIpcCallResult.mockImplementation(
      (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
        if (method === "getExpanded") {
          return Promise.resolve({ ok: true as const, value: { relPaths: ["a", "a/b", "c"] } });
        }
        if (method === "readdir") {
          callOrder.push(args.relPath);
          const responses: Record<string, DirEntry[]> = {
            "": [dirEntry("a", "dir"), dirEntry("c", "dir")],
            a: [dirEntry("b", "dir")],
            "a/b": [],
            c: [],
          };
          return Promise.resolve({ ok: true as const, value: responses[args.relPath] ?? [] });
        }
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    );

    await ensureRoot(WS_ID, ROOT);

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
