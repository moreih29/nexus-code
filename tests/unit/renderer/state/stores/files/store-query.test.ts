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
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ensureRoot, toggleExpand } from "../../../../../../src/renderer/state/operations/files";
import { handleFsChanged, useFilesStore } from "../../../../../../src/renderer/state/stores/files";
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

    await ensureRoot(WS_ID, ROOT);
    await toggleExpand(WS_ID, srcAbs);

    mockIpcCallResult.mockClear();
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

    await new Promise((r) => setTimeout(r, 0));

    expect(mockIpcCallResult).toHaveBeenCalledWith("fs", "readdir", {
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

    await ensureRoot(WS_ID, ROOT);
    await toggleExpand(WS_ID, srcAbs);
    await toggleExpand(WS_ID, srcAbs);

    const beforeTree = useFilesStore.getState().trees.get(WS_ID);
    expect(beforeTree?.expanded.has(srcAbs)).toBe(false);

    mockIpcCallResult.mockClear();

    handleFsChanged({
      workspaceId: WS_ID,
      changes: [{ relPath: "src/new.ts", kind: "added" }],
    });

    expect(mockIpcCallResult).not.toHaveBeenCalledWith("fs", "readdir", expect.anything());
    const afterTree = useFilesStore.getState().trees.get(WS_ID);
    expect(afterTree?.nodes.get(srcAbs)?.childrenLoaded).toBe(false);
  });
});
