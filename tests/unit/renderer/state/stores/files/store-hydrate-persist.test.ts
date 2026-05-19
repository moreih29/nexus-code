import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

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

import { ensureRoot, toggleExpand } from "../../../../../../src/renderer/state/operations/files";
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

  it("seeds expanded set from getExpanded and loads children for each", async () => {
    const srcAbs = `${ROOT}/src`;
    const componentsAbs = `${ROOT}/src/components`;

    mockIpcCallResult.mockImplementation(
      (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
        if (method === "getExpanded") {
          return Promise.resolve({
            ok: true as const,
            value: { relPaths: ["src", "src/components"] },
          });
        }
        if (method === "readdir") {
          const responses: Record<string, DirEntry[]> = {
            "": [dirEntry("src", "dir")],
            src: [dirEntry("components", "dir")],
            "src/components": [dirEntry("Button.tsx", "file")],
          };
          return Promise.resolve({ ok: true as const, value: responses[args.relPath] ?? [] });
        }
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    );

    await ensureRoot(WS_ID, ROOT);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree?.expanded.has(srcAbs)).toBe(true);
    expect(tree?.expanded.has(componentsAbs)).toBe(true);
    expect(tree?.nodes.get(srcAbs)?.childrenLoaded).toBe(true);
    expect(tree?.nodes.get(componentsAbs)?.childrenLoaded).toBe(true);
    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "src",
    });
    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "watch", {
      workspaceId: WS_ID,
      relPath: "src/components",
    });
  });

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
// Scenario 9: toggleExpand debounces setExpanded persist after 200ms
// ---------------------------------------------------------------------------

describe("Scenario 9: toggleExpand debounces setExpanded persist", () => {
  beforeEach(resetStore);

  it("calls setExpanded with current expanded relPaths after debounce delay", async () => {
    jest.useFakeTimers();
    try {
      const srcAbs = `${ROOT}/src`;

      mockIpcCallResult.mockImplementation(
        (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
          if (method === "getExpanded")
            return Promise.resolve({ ok: true as const, value: { relPaths: [] } });
          if (method === "readdir") {
            const responses: Record<string, DirEntry[]> = {
              "": [dirEntry("src", "dir")],
              src: [dirEntry("index.ts", "file")],
            };
            return Promise.resolve({ ok: true as const, value: responses[args.relPath] ?? [] });
          }
          return Promise.resolve({ ok: true as const, value: undefined });
        },
      );

      await ensureRoot(WS_ID, ROOT);
      mockIpcCallResult.mockClear();

      const setExpandedCalls: { workspaceId: string; relPaths: string[] }[] = [];
      mockIpcCallResult.mockImplementation(
        (
          _channel: string,
          method: string,
          args: { workspaceId: string; relPaths?: string[]; relPath?: string },
        ) => {
          if (method === "setExpanded") {
            setExpandedCalls.push({ workspaceId: args.workspaceId, relPaths: args.relPaths ?? [] });
            return Promise.resolve({ ok: true as const, value: undefined });
          }
          if (method === "readdir")
            return Promise.resolve({ ok: true as const, value: [dirEntry("index.ts", "file")] });
          return Promise.resolve({ ok: true as const, value: undefined });
        },
      );

      await toggleExpand(WS_ID, srcAbs);

      jest.advanceTimersByTime(250);

      expect(setExpandedCalls).toHaveLength(1);
      expect(setExpandedCalls[0].workspaceId).toBe(WS_ID);
      expect(setExpandedCalls[0].relPaths).toContain("src");
      expect(setExpandedCalls[0].relPaths).not.toContain("");
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: ensureRoot hydrate — depth-grouped parallel readdir calls
// ---------------------------------------------------------------------------

describe("Scenario 12: ensureRoot hydrate parallel readdir", () => {
  beforeEach(resetStore);

  it("issues 1 + N readdir calls total when N dirs are in persisted expanded set", async () => {
    const dirs = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const readdirResponses: Record<string, DirEntry[]> = {
      "": dirs.map((d) => dirEntry(d, "dir")),
    };
    for (const d of dirs) {
      readdirResponses[d] = [];
    }

    mockIpcCallResult.mockImplementation(
      (_channel: string, method: string, args: { workspaceId: string; relPath: string }) => {
        if (method === "getExpanded") {
          return Promise.resolve({ ok: true as const, value: { relPaths: dirs } });
        }
        if (method === "readdir") {
          return Promise.resolve({
            ok: true as const,
            value: readdirResponses[args.relPath] ?? [],
          });
        }
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    );

    await ensureRoot(WS_ID, ROOT);

    const readdirCalls = mockIpcCallResult.mock.calls.filter(([, m]) => m === "readdir");
    expect(readdirCalls).toHaveLength(11);
  });

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
