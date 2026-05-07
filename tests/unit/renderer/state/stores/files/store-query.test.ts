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

const mockIpcListen = mock((_channel: string, _event: string, _cb: unknown) => () => {});

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mockIpcCall,
  ipcListen: mockIpcListen,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  ensureRoot,
  refresh,
  reveal,
  toggleExpand,
} from "../../../../../../src/renderer/state/operations/files";
import {
  handleFsChanged,
  selectFlat,
  useFilesStore,
} from "../../../../../../src/renderer/state/stores/files";
import type { DirEntry } from "../../../../../../src/shared/types/fs";

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
      return Promise.resolve(undefined);
    },
  );
}

// ---------------------------------------------------------------------------
// Scenario 4: refresh → childrenLoaded=false → reload
// ---------------------------------------------------------------------------

describe("Scenario 4: refresh reloads", () => {
  beforeEach(resetStore);

  it("resets childrenLoaded and calls readdir again", async () => {
    setupReaddir(new Map([["", [dirEntry("a.txt", "file")]]]));

    await ensureRoot(WS_ID, ROOT);

    const before = useFilesStore.getState().trees.get(WS_ID);
    expect(before?.nodes.get(ROOT)?.childrenLoaded).toBe(true);

    mockIpcCall.mockClear();
    setupReaddir(new Map([["", [dirEntry("a.txt", "file"), dirEntry("b.txt", "file")]]]));

    await refresh(WS_ID);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    const after = useFilesStore.getState().trees.get(WS_ID);
    expect(after?.nodes.get(ROOT)?.childrenLoaded).toBe(true);
    expect(after?.nodes.get(ROOT)?.children).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: reveal → all ancestor dirs expanded
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

    await ensureRoot(WS_ID, ROOT);
    await reveal(WS_ID, buttonAbs);

    const tree = useFilesStore.getState().trees.get(WS_ID);
    expect(tree?.expanded.has(ROOT)).toBe(true);
    expect(tree?.expanded.has(srcAbs)).toBe(true);
    expect(tree?.expanded.has(componentsAbs)).toBe(true);

    expect(tree?.nodes.has(buttonAbs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: selectFlat ordering — dirs first + alphabetical
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

    await ensureRoot(WS_ID, ROOT);

    const flat = selectFlat(useFilesStore.getState(), WS_ID);
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

    await ensureRoot(WS_ID, ROOT);
    await toggleExpand(WS_ID, srcAbs);

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

    await ensureRoot(WS_ID, ROOT);
    await toggleExpand(WS_ID, srcAbs);

    mockIpcCall.mockClear();
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

    await ensureRoot(WS_ID, ROOT);
    await toggleExpand(WS_ID, srcAbs);
    await toggleExpand(WS_ID, srcAbs);

    const beforeTree = useFilesStore.getState().trees.get(WS_ID);
    expect(beforeTree?.expanded.has(srcAbs)).toBe(false);

    mockIpcCall.mockClear();

    handleFsChanged({
      workspaceId: WS_ID,
      changes: [{ relPath: "src/new.ts", kind: "added" }],
    });

    expect(mockIpcCall).not.toHaveBeenCalledWith("fs", "readdir", expect.anything());
    const afterTree = useFilesStore.getState().trees.get(WS_ID);
    expect(afterTree?.nodes.get(srcAbs)?.childrenLoaded).toBe(false);
  });
});
