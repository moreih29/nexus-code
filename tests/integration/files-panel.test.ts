/**
 * Integration: FilesPanel + FileTree + files store + tabs store
 *
 * SCOPE
 * -----
 * Cross-store integration only. Scenarios that exercise a single store
 * (files store ensure/toggle/refresh, UI store resize) live in their
 * unit suites — running them again here added duplication without
 * additional cross-store coverage.
 *
 * What stays here:
 *   - File click → openOrRevealEditor: files store + tabs store + layout
 *   - Workspace isolation: state in WS_A does not bleed into WS_B
 *   - Editor tabs are workspace-scoped (Cross-store)
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * Automated (this file):
 *   - Cross-store coordination (files + tabs + layout)
 *   - Per-workspace store entry isolation
 *
 * NOT automated (DOM / Electron only):
 *   - React component rendering (no jsdom in bun:test)
 *   - PTY process survival across workspace switches
 *   - Cmd+R browser-level page-reload prevention
 *   - CSS visibility toggling on workspace switch
 *
 * RUNBOOK (manual smoke):
 *   PTY survival on workspace switch
 *     1. Launch Nexus, create two workspaces (WS-A, WS-B).
 *     2. With WS-A active, run `ping localhost` in a terminal tab.
 *     3. Switch to WS-B; wait 3s; switch back to WS-A.
 *     4. PASS: ping output continues without restart, cursor preserved.
 *     5. PASS: WS-B opens with its own (independent) terminal.
 *
 *   Cmd+R refresh blocks Chromium reload
 *     1. Launch Nexus, open a workspace with files.
 *     2. Press Cmd+R while focused inside the window.
 *     3. PASS: app does NOT reload (no DevTools network reset, no
 *        workspace re-init flash). The file tree re-populates.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so every store module loads without DOM / Electron preload.
// Must happen before any store import.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Mock ipcCall globally — all three stores share the same mock handle.
// ---------------------------------------------------------------------------

const mockIpcCall = mock((_channel: string, _method: string, _args: unknown) =>
  Promise.resolve([]),
);

mock.module("../../src/renderer/ipc/client", () => ({
  ipcCall: mockIpcCall,
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks are installed
// ---------------------------------------------------------------------------

import { openOrRevealEditor } from "../../src/renderer/services/editor";
import { useFilesStore } from "../../src/renderer/state/stores/files";
import { useLayoutStore } from "../../src/renderer/state/stores/layout";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";
import type { DirEntry } from "../../src/shared/types/fs";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WS_A = "10000000-0000-0000-0000-000000000001";
const WS_B = "20000000-0000-0000-0000-000000000002";
const ROOT_A = "/ws-a/project";
const ROOT_B = "/ws-b/other";

function dirEntry(name: string, type: DirEntry["type"] = "file"): DirEntry {
  return { name, type };
}

function setupReaddir(responses: Map<string, DirEntry[]>) {
  mockIpcCall.mockImplementation(
    (
      _channel: string,
      method: string,
      args: { workspaceId?: string; relPath?: string } | unknown,
    ) => {
      // getExpanded must return { relPaths: [] } — not a plain array.
      if (method === "getExpanded") {
        return Promise.resolve({ relPaths: [] });
      }
      // watch / unwatch / setExpanded resolve void
      if (method === "watch" || method === "unwatch" || method === "setExpanded") {
        return Promise.resolve(undefined);
      }
      const a = args as { workspaceId?: string; relPath?: string };
      const key = a?.relPath ?? "";
      return Promise.resolve(responses.get(key) ?? []);
    },
  );
}

function resetAllStores() {
  useFilesStore.setState({ trees: new Map() });
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
  mockIpcCall.mockClear();
}

// ---------------------------------------------------------------------------
// File click → openOrRevealEditor + tabs/layout stores reflect the result
//
// The FileTree component's handleRowClick (for a file node) calls
//   openOrRevealEditor({ workspaceId, filePath })
// We replicate that call directly and verify the *cross-store* outcome
// (files store + tabs store + layout store all converge correctly).
// ---------------------------------------------------------------------------

describe("File click → openOrRevealEditor wires tabs + layout stores together", () => {
  beforeEach(resetAllStores);

  it("openOrRevealEditor creates an editor tab in the workspace slice", () => {
    const filePath = `${ROOT_A}/src/index.ts`;

    openOrRevealEditor({ workspaceId: WS_A, filePath });

    const record = useTabsStore.getState().byWorkspace[WS_A];
    expect(record).toBeDefined();
    const tabs = Object.values(record ?? {});
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.type).toBe("editor");
  });

  it("the new tab carries filePath and workspaceId props", () => {
    const filePath = `${ROOT_A}/src/App.tsx`;

    openOrRevealEditor({ workspaceId: WS_A, filePath });

    const tabs = Object.values(useTabsStore.getState().byWorkspace[WS_A] ?? {});
    expect(tabs[0]?.props).toEqual({ filePath, workspaceId: WS_A });
  });

  it("the new tab title defaults to the file's basename", () => {
    const filePath = `${ROOT_A}/src/utils.ts`;

    openOrRevealEditor({ workspaceId: WS_A, filePath });

    const tabs = Object.values(useTabsStore.getState().byWorkspace[WS_A] ?? {});
    expect(tabs[0]?.title).toBe("utils.ts");
  });

  it("the new tab becomes the active tab in its layout group", () => {
    const filePath = `${ROOT_A}/src/main.ts`;

    const tab = openOrRevealEditor({ workspaceId: WS_A, filePath });

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    expect(layout).toBeDefined();
    expect(layout?.activeGroupId).toBe(tab.groupId);
  });

  it("clicking two different files reuses the preview slot (second replaces first)", () => {
    // PREVIEW_ENABLED: a single-click on a.ts opens it as a preview tab; a
    // subsequent single-click on b.ts replaces the same preview slot with
    // b.ts. This is a cross-store invariant — preview-slot reuse lives in
    // services/editor while the resulting record lives in tabsStore.
    openOrRevealEditor({ workspaceId: WS_A, filePath: `${ROOT_A}/a.ts` });
    openOrRevealEditor({ workspaceId: WS_A, filePath: `${ROOT_A}/b.ts` });

    const tabs = Object.values(useTabsStore.getState().byWorkspace[WS_A] ?? {});
    expect(tabs).toHaveLength(1);
    const tab = tabs[0];
    expect((tab?.props as { filePath: string }).filePath).toBe(`${ROOT_A}/b.ts`);
    expect(tab?.isPreview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-workspace isolation across the files / tabs / layout stores.
//
// The files store is per-workspace by design; verifying isolation here is
// cross-cutting because the test exercises both store boundaries (no leaked
// trees AND no leaked tabs across workspaces).
// ---------------------------------------------------------------------------

describe("Per-workspace isolation across files + tabs stores", () => {
  beforeEach(resetAllStores);

  it("ensureRoot for WS_A then WS_B creates two distinct tree entries", async () => {
    setupReaddir(new Map([["", [dirEntry("src", "dir")]]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().ensureRoot(WS_B, ROOT_B);

    const trees = useFilesStore.getState().trees;
    expect(trees.has(WS_A)).toBe(true);
    expect(trees.has(WS_B)).toBe(true);
    expect(trees.size).toBe(2);
    expect(trees.get(WS_A)?.rootAbsPath).toBe(ROOT_A);
    expect(trees.get(WS_B)?.rootAbsPath).toBe(ROOT_B);
  });

  it("expansion state in WS_A does not affect WS_B tree", async () => {
    const srcA = `${ROOT_A}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().ensureRoot(WS_B, ROOT_B);
    await useFilesStore.getState().toggleExpand(WS_A, srcA);

    expect(useFilesStore.getState().trees.get(WS_A)?.expanded.has(srcA)).toBe(true);
    // WS_B has no srcA path — its expanded set should not contain it.
    expect(useFilesStore.getState().trees.get(WS_B)?.expanded.has(srcA)).toBe(false);
  });

  it("openOrRevealEditor for WS_A does not create entries for WS_B", () => {
    openOrRevealEditor({ workspaceId: WS_A, filePath: `${ROOT_A}/src/index.ts` });

    expect(useTabsStore.getState().byWorkspace[WS_B]).toBeUndefined();
  });

  it("opening the same file in two workspaces produces two independent tabs", () => {
    openOrRevealEditor({ workspaceId: WS_A, filePath: `${ROOT_A}/src/a.ts` });
    openOrRevealEditor({ workspaceId: WS_B, filePath: `${ROOT_B}/src/b.ts` });

    const tabsA = Object.values(useTabsStore.getState().byWorkspace[WS_A] ?? {});
    const tabsB = Object.values(useTabsStore.getState().byWorkspace[WS_B] ?? {});
    expect(tabsA).toHaveLength(1);
    expect(tabsB).toHaveLength(1);
  });

  it("refresh on WS_A does not disturb WS_B tree (cross-workspace isolation under invalidation)", async () => {
    setupReaddir(new Map([["", [dirEntry("file.ts", "file")]]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().ensureRoot(WS_B, ROOT_B);

    setupReaddir(new Map([["", []]]));
    await useFilesStore.getState().refresh(WS_A);

    expect(useFilesStore.getState().trees.has(WS_B)).toBe(true);
  });
});
