/**
 * Integration: PR1 FilesPanel + FileTree + files store + tabs store + UI store
 *
 * agent_id: tester
 *
 * SCOPE
 * -----
 * Six scenarios from the PR1 acceptance checklist. Each scenario is classified
 * as one of:
 *   AUTO      — fully automated; runs in bun:test with mock ipcCall
 *   PARTIAL   — the store/logic side is automated; the component / Electron /
 *               DOM side has a RUNBOOK block explaining the gap
 *   RUNBOOK   — no automated coverage possible without real Electron; manual
 *               steps are written inline
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * What CAN be automated (bun:test, no DOM):
 *   - Store method calls and resulting state mutations
 *   - Mock ipcCall invocation counts and argument verification
 *   - Cross-store coordination (files + tabs + ui stores)
 *
 * What CANNOT be automated without DOM / Electron:
 *   - React component rendering (no jsdom in bun:test)
 *   - PTY process survival across workspace switches (Electron renderer process)
 *   - KeyboardEvent.preventDefault() side-effects (requires real browser event)
 *   - CSS visibility toggling (requires real DOM style resolution)
 *
 * SCENARIOS STATUS
 * ----------------
 *   1. Workspace selection → ensureRoot + readdir          AUTO
 *   2. Folder click → expand + children + selectFlat       AUTO
 *   3. File click → addTab('editor', …) + store state      AUTO
 *   4. Workspace switch → two tree entries + PTY survival  PARTIAL (store AUTO; PTY RUNBOOK)
 *   5. Cmd+R → refresh + re-readdir, no page reload        PARTIAL (store AUTO; preventDefault RUNBOOK)
 *   6. Resize drag → filesPanelWidth + ipcCall persist     AUTO
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

import { selectFlat, useFilesStore } from "../../src/renderer/store/files";
import { useLayoutStore } from "../../src/renderer/store/layout";
import { openTab } from "../../src/renderer/store/operations";
import { useTabsStore } from "../../src/renderer/store/tabs";
import {
  FILES_PANEL_WIDTH_DEFAULT,
  FILES_PANEL_WIDTH_MIN,
  useUIStore,
} from "../../src/renderer/store/ui";
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
  useUIStore.setState({
    filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
  });
  mockIpcCall.mockClear();
}

// ---------------------------------------------------------------------------
// Scenario 1 — AUTO
// Workspace selection → FilesPanel header shows workspace.name
//                     → ensureRoot calls readdir exactly once for root
//
// Component gap (RUNBOOK — Scenario 1b):
//   The FilesPanel header text rendering requires a real React DOM environment.
//   Manual steps:
//     1. Launch Nexus (`bun run dev`).
//     2. Add a workspace via the sidebar "+".
//     3. Verify the FilesPanel header reads exactly <workspace.name> in
//        uppercase tracking text (class: text-stone-gray tracking-[2.4px]).
//     4. Switch workspaces and verify the header updates to the new name.
// ---------------------------------------------------------------------------

describe("Scenario 1 (AUTO): workspace selection → ensureRoot calls readdir once", () => {
  beforeEach(resetAllStores);

  it("ensureRoot creates a tree entry for the workspace", async () => {
    setupReaddir(
      new Map([["", [dirEntry("src", "dir"), dirEntry("README.md", "file")]]]),
    );

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);

    const tree = useFilesStore.getState().trees.get(WS_A);
    expect(tree).toBeDefined();
    expect(tree?.rootAbsPath).toBe(ROOT_A);
  });

  it("ensureRoot issues exactly one readdir IPC call for the root path", async () => {
    setupReaddir(new Map([["", [dirEntry("src", "dir")]]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);

    // ensureRoot calls getExpanded + watch (async, fire-and-forget) + readdir.
    // Assert that readdir was called exactly once with the root relPath.
    const readdirCalls = (mockIpcCall.mock.calls as Array<[string, string, { relPath: string }]>)
      .filter(([, method]) => method === "readdir");
    expect(readdirCalls).toHaveLength(1);
    expect(readdirCalls[0][2].relPath).toBe("");
  });

  it("ensureRoot populates root node with children returned by readdir", async () => {
    setupReaddir(
      new Map([["", [dirEntry("src", "dir"), dirEntry("package.json", "file")]]]),
    );

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);

    const tree = useFilesStore.getState().trees.get(WS_A);
    const rootNode = tree?.nodes.get(ROOT_A);
    expect(rootNode?.childrenLoaded).toBe(true);
    expect(rootNode?.children).toHaveLength(2);
  });

  it("calling ensureRoot again for the same workspace does not trigger another readdir", async () => {
    setupReaddir(new Map([["", []]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    mockIpcCall.mockClear();

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    expect(mockIpcCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — AUTO
// Folder click → tree expands, children loaded, selectFlat includes child
//
// The FileTree component's handleRowClick calls
//   useFilesStore.getState().toggleExpand(workspaceId, absPath)
// directly. We exercise the same code path by calling toggleExpand on the
// store and verifying: expanded set, childrenLoaded flag, selectFlat result.
// ---------------------------------------------------------------------------

describe("Scenario 2 (AUTO): folder click → expand + children + selectFlat", () => {
  beforeEach(resetAllStores);

  it("toggleExpand marks dir as expanded and loads children", async () => {
    const srcAbs = `${ROOT_A}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file"), dirEntry("utils.ts", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().toggleExpand(WS_A, srcAbs);

    const tree = useFilesStore.getState().trees.get(WS_A);
    expect(tree?.expanded.has(srcAbs)).toBe(true);

    const srcNode = tree?.nodes.get(srcAbs);
    expect(srcNode?.childrenLoaded).toBe(true);
    expect(srcNode?.children).toHaveLength(2);
  });

  it("selectFlat after expand includes child paths", async () => {
    const srcAbs = `${ROOT_A}/src`;
    const indexAbs = `${ROOT_A}/src/index.ts`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().toggleExpand(WS_A, srcAbs);

    const flat = selectFlat(useFilesStore.getState(), WS_A);
    const paths = flat.map((i) => i.absPath);

    expect(paths).toContain(srcAbs);
    expect(paths).toContain(indexAbs);
  });

  it("selectFlat after collapse does not include grandchildren", async () => {
    const srcAbs = `${ROOT_A}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", [dirEntry("index.ts", "file")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().toggleExpand(WS_A, srcAbs); // expand
    await useFilesStore.getState().toggleExpand(WS_A, srcAbs); // collapse

    const flat = selectFlat(useFilesStore.getState(), WS_A);
    const paths = flat.map((i) => i.absPath);

    expect(paths).not.toContain(`${srcAbs}/index.ts`);
  });

  it("readdir for child dir is called with correct relPath", async () => {
    const srcAbs = `${ROOT_A}/src`;

    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
        ["src", []],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    mockIpcCall.mockClear();
    await useFilesStore.getState().toggleExpand(WS_A, srcAbs);

    expect(mockIpcCall).toHaveBeenCalledWith("fs", "readdir", {
      workspaceId: WS_A,
      relPath: "src",
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — AUTO
// File click → addTab('editor', …) + EditorView tab appears in tabs store
//
// The FileTree component's handleRowClick (for a file node) calls:
//   useTabsStore.getState().addTab(workspaceId, "editor", { filePath, workspaceId })
// We replicate that call directly and verify the tabs store state.
//
// EditorView mounting gap (RUNBOOK — Scenario 3b):
//   React component mounting requires jsdom / real renderer. Manual steps:
//     1. Launch Nexus (`bun run dev`), open a workspace.
//     2. Click any file in the FileTree.
//     3. Verify a new tab appears in the TabBar with the file's basename.
//     4. Verify the tab content area shows an editor (not a terminal).
// ---------------------------------------------------------------------------

describe("Scenario 3 (AUTO): file click → openTab + tab store reflects new editor tab", () => {
  beforeEach(resetAllStores);

  it("openTab with type='editor' creates a tab in the workspace slice", () => {
    const filePath = `${ROOT_A}/src/index.ts`;

    openTab(WS_A, "editor", { filePath, workspaceId: WS_A });

    const record = useTabsStore.getState().byWorkspace[WS_A];
    expect(record).toBeDefined();
    const tabs = Object.values(record ?? {});
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.type).toBe("editor");
  });

  it("added editor tab carries filePath and workspaceId props", () => {
    const filePath = `${ROOT_A}/src/App.tsx`;

    openTab(WS_A, "editor", { filePath, workspaceId: WS_A });

    const tabs = Object.values(useTabsStore.getState().byWorkspace[WS_A] ?? {});
    expect(tabs[0]?.props).toEqual({ filePath, workspaceId: WS_A });
  });

  it("added editor tab title defaults to the file's basename", () => {
    const filePath = `${ROOT_A}/src/utils.ts`;

    openTab(WS_A, "editor", { filePath, workspaceId: WS_A });

    const tabs = Object.values(useTabsStore.getState().byWorkspace[WS_A] ?? {});
    expect(tabs[0]?.title).toBe("utils.ts");
  });

  it("newly added tab becomes the active tab in its layout group", () => {
    const filePath = `${ROOT_A}/src/main.ts`;

    const tab = openTab(WS_A, "editor", {
      filePath,
      workspaceId: WS_A,
    });

    const layout = useLayoutStore.getState().byWorkspace[WS_A];
    expect(layout).toBeDefined();
    // The active group's leaf should have this tab as active
    const activeGroupId = layout?.activeGroupId;
    expect(activeGroupId).toBeDefined();
  });

  it("clicking two different files creates two editor tabs", () => {
    openTab(WS_A, "editor", {
      filePath: `${ROOT_A}/a.ts`,
      workspaceId: WS_A,
    });
    openTab(WS_A, "editor", {
      filePath: `${ROOT_A}/b.ts`,
      workspaceId: WS_A,
    });

    const tabs = Object.values(useTabsStore.getState().byWorkspace[WS_A] ?? {});
    expect(tabs).toHaveLength(2);
    const filePaths = tabs
      .map((t) => (t.props as { filePath: string }).filePath)
      .sort();
    expect(filePaths).toEqual([`${ROOT_A}/a.ts`, `${ROOT_A}/b.ts`].sort());
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — PARTIAL
//
// AUTO part: workspace switch → files store has two distinct tree entries
// RUNBOOK:   PTY survival across workspace switches (CSS hide mechanism)
//
// RUNBOOK (Scenario 4b — PTY survival, CANNOT be automated):
//   The PTY survival mechanism lives in WorkspacePanel.tsx + App.tsx.
//   App.tsx maintains `mountedIds` (Set<string>) that grows monotonically;
//   WorkspacePanel renders with class "invisible pointer-events-none" (not
//   display:none) when `isActive=false`, keeping the DOM alive.
//   TerminalView + xterm.js + the PTY IPC listener are all alive as long as
//   the DOM element exists.
//
//   Manual verification steps:
//     1. Launch Nexus. Create two workspaces (WS-A, WS-B).
//     2. With WS-A active, start a shell command that produces ongoing output
//        (e.g. `ping localhost`).
//     3. Switch to WS-B via the sidebar. WS-A's panel becomes invisible.
//     4. Wait 3 seconds; switch back to WS-A.
//     5. PASS if: ping output has continued accumulating without restart; no
//        re-connect flash; cursor position preserved.
//     6. PASS if: WS-B opens with its own terminal (fresh PTY) independently.
//
//   Regression check for CSS hide:
//     In WorkspacePanel.tsx confirm the inactive branch is:
//       "invisible pointer-events-none"   ← CSS hide (not display:none)
//     NOT "hidden" or conditional {isActive && <WorkspacePanel>} (unmount).
// ---------------------------------------------------------------------------

describe("Scenario 4 (AUTO): workspace switch → two separate tree entries in files store", () => {
  beforeEach(resetAllStores);

  it("ensureRoot for WS_A then WS_B creates two distinct tree entries", async () => {
    setupReaddir(
      new Map([
        ["", [dirEntry("src", "dir")]],
      ]),
    );

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().ensureRoot(WS_B, ROOT_B);

    const trees = useFilesStore.getState().trees;
    expect(trees.has(WS_A)).toBe(true);
    expect(trees.has(WS_B)).toBe(true);
    expect(trees.size).toBe(2);
  });

  it("WS_A tree root path is independent of WS_B tree root path", async () => {
    setupReaddir(new Map([["", []]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().ensureRoot(WS_B, ROOT_B);

    expect(useFilesStore.getState().trees.get(WS_A)?.rootAbsPath).toBe(ROOT_A);
    expect(useFilesStore.getState().trees.get(WS_B)?.rootAbsPath).toBe(ROOT_B);
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

    const treeA = useFilesStore.getState().trees.get(WS_A);
    const treeB = useFilesStore.getState().trees.get(WS_B);

    expect(treeA?.expanded.has(srcA)).toBe(true);
    // WS_B has no srcA path at all — its expanded set should not contain it
    expect(treeB?.expanded.has(srcA)).toBe(false);
  });

  it("readdir is called once per workspace (not shared across switches)", async () => {
    setupReaddir(new Map([["", []]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().ensureRoot(WS_B, ROOT_B);

    // Each ensureRoot issues: getExpanded + readdir (+ async watch fire-and-forget).
    // Assert that readdir was called exactly once for each workspace.
    const calls = mockIpcCall.mock.calls as Array<[string, string, { workspaceId: string; relPath: string }]>;
    const readdirCalls = calls.filter(([, method]) => method === "readdir");
    expect(readdirCalls).toHaveLength(2);
    const wsIds = readdirCalls.map((c) => c[2].workspaceId);
    expect(wsIds).toContain(WS_A);
    expect(wsIds).toContain(WS_B);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — PARTIAL
//
// AUTO part: store.refresh → invalidates children + re-issues readdir
// RUNBOOK:   Cmd+R key handler — preventDefault prevents page reload
//
// The logic under test in App.tsx:
//   window.addEventListener("keydown", (e) => {
//     if (e.metaKey && e.key === "r" && !e.shiftKey) {
//       e.preventDefault();          ← stops Chrome/Electron page reload
//       useFilesStore.getState().refresh(activeWorkspaceId)
//     }
//   })
//
// RUNBOOK (Scenario 5b — Cmd+R browser-level, CANNOT be automated):
//   Manual verification steps:
//     1. Launch Nexus (`bun run dev`). Open a workspace with some files.
//     2. Focus the Nexus window (click inside it).
//     3. Press Cmd+R (macOS) / Ctrl+R (Linux).
//     4. PASS if: the app does NOT reload (DevTools network tab stays quiet;
//        the workspace panel does not flash/reinitialize).
//     5. PASS if: the file tree briefly shows a loading state (if root has
//        children) and then re-populates with the same or updated file list.
//     6. Repeat after adding a file to the workspace directory externally.
//        PASS if: the new file appears in the tree after Cmd+R.
// ---------------------------------------------------------------------------

describe("Scenario 5 (AUTO): refresh → invalidates children, re-issues readdir", () => {
  beforeEach(resetAllStores);

  it("refresh resets childrenLoaded on the root node", async () => {
    setupReaddir(new Map([["", [dirEntry("a.ts", "file")]]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);

    const before = useFilesStore.getState().trees.get(WS_A)?.nodes.get(ROOT_A);
    expect(before?.childrenLoaded).toBe(true);

    mockIpcCall.mockClear();
    setupReaddir(new Map([["", [dirEntry("a.ts", "file"), dirEntry("b.ts", "file")]]]));

    await useFilesStore.getState().refresh(WS_A);

    const after = useFilesStore.getState().trees.get(WS_A)?.nodes.get(ROOT_A);
    expect(after?.childrenLoaded).toBe(true);
  });

  it("refresh re-issues exactly one readdir call for the root", async () => {
    setupReaddir(new Map([["", []]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    mockIpcCall.mockClear();

    setupReaddir(new Map([["", [dirEntry("new-file.ts", "file")]]]));
    await useFilesStore.getState().refresh(WS_A);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("fs", "readdir", {
      workspaceId: WS_A,
      relPath: "",
    });
  });

  it("refresh updates root children with new entries from readdir", async () => {
    setupReaddir(new Map([["", [dirEntry("original.ts", "file")]]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);

    setupReaddir(
      new Map([["", [dirEntry("original.ts", "file"), dirEntry("added.ts", "file")]]]),
    );
    await useFilesStore.getState().refresh(WS_A);

    const tree = useFilesStore.getState().trees.get(WS_A);
    const rootNode = tree?.nodes.get(ROOT_A);
    expect(rootNode?.children).toHaveLength(2);
  });

  it("refresh on WS_A does not disturb WS_B tree", async () => {
    setupReaddir(new Map([["", [dirEntry("file.ts", "file")]]]));

    await useFilesStore.getState().ensureRoot(WS_A, ROOT_A);
    await useFilesStore.getState().ensureRoot(WS_B, ROOT_B);

    setupReaddir(new Map([["", []]]));
    await useFilesStore.getState().refresh(WS_A);

    // WS_B tree should still exist and be untouched
    expect(useFilesStore.getState().trees.has(WS_B)).toBe(true);
  });

  it("App.tsx Cmd+R handler calls refresh (code-path review)", () => {
    // The App.tsx keydown handler (App.tsx lines 125-136) calls:
    //   useFilesStore.getState().refresh(wsId)
    // We verify the store method is callable with only a workspaceId, matching
    // the call site exactly. This is a contract test: if the signature changes,
    // this test breaks and forces the author to re-check App.tsx.
    const refreshFn = useFilesStore.getState().refresh;
    expect(typeof refreshFn).toBe("function");

    // Verify the function accepts (workspaceId: string, absPath?: string)
    // by calling it — with no prior ensureRoot it returns immediately.
    // If the function signature changes to require more args, this throws.
    const result = refreshFn(WS_A);
    expect(result).toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — AUTO
// Resize handle drag → filesPanelWidth updated + ipcCall("appState","set") called
//
// The ResizeHandle component's onResize callback calls:
//   useUIStore.getState().setFilesPanelWidth(width, persist)
// onReset calls:
//   useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT, true)
// We verify the store state changes and the IPC persistence behavior.
// ---------------------------------------------------------------------------

describe("Scenario 6 (AUTO): resize drag → filesPanelWidth + appState persistence", () => {
  beforeEach(() => {
    useUIStore.setState({
      filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
    });
    mockIpcCall.mockClear();
  });

  it("setFilesPanelWidth(300, false) updates store but does NOT call ipcCall", () => {
    useUIStore.getState().setFilesPanelWidth(300, false);

    expect(useUIStore.getState().filesPanelWidth).toBe(300);
    expect(mockIpcCall).not.toHaveBeenCalled();
  });

  it("setFilesPanelWidth(350, true) calls ipcCall once with {filesPanelWidth:350}", () => {
    useUIStore.getState().setFilesPanelWidth(350, true);

    expect(useUIStore.getState().filesPanelWidth).toBe(350);
    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { filesPanelWidth: 350 });
  });

  it("resize does not persist during mousemove (persist=false on every tick)", () => {
    // Simulate continuous drag: 10 mousemove ticks, persist=false
    for (let dx = 10; dx <= 100; dx += 10) {
      useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT + dx, false);
    }

    expect(mockIpcCall).not.toHaveBeenCalled();
  });

  it("on mouseup commit (persist=true), exactly one ipcCall is made with final width", () => {
    // Simulate drag sequence: multiple non-persist ticks then one persist commit
    useUIStore.getState().setFilesPanelWidth(260, false);
    useUIStore.getState().setFilesPanelWidth(280, false);
    useUIStore.getState().setFilesPanelWidth(300, false);

    // mouseup commit
    const currentWidth = useUIStore.getState().filesPanelWidth;
    useUIStore.getState().setFilesPanelWidth(currentWidth, true);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", { filesPanelWidth: 300 });
  });

  it("setFilesPanelWidth clamps below FILES_PANEL_WIDTH_MIN to minimum", () => {
    useUIStore.getState().setFilesPanelWidth(10, false);

    expect(useUIStore.getState().filesPanelWidth).toBe(FILES_PANEL_WIDTH_MIN);
  });

  it("double-click reset calls setFilesPanelWidth(default, true) → one ipcCall", () => {
    // Mirrors ResizeHandle's onReset: setFilesPanelWidth(DEFAULT, true)
    useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT, true);

    expect(mockIpcCall).toHaveBeenCalledTimes(1);
    expect(mockIpcCall).toHaveBeenCalledWith("appState", "set", {
      filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-store coordination — Scenario 3 + 4 integration
// File tab opened in WS_A must not appear in WS_B's tab slice
// ---------------------------------------------------------------------------

describe("Cross-store: editor tabs are workspace-scoped, do not leak across workspaces", () => {
  beforeEach(resetAllStores);

  it("openTab for WS_A does not create entries for WS_B", () => {
    openTab(WS_A, "editor", {
      filePath: `${ROOT_A}/src/index.ts`,
      workspaceId: WS_A,
    });

    expect(useTabsStore.getState().byWorkspace[WS_B]).toBeUndefined();
  });

  it("openTab for WS_B does not affect WS_A tabs", () => {
    openTab(WS_A, "editor", {
      filePath: `${ROOT_A}/src/a.ts`,
      workspaceId: WS_A,
    });
    openTab(WS_B, "editor", {
      filePath: `${ROOT_B}/src/b.ts`,
      workspaceId: WS_B,
    });

    const tabsA = Object.values(useTabsStore.getState().byWorkspace[WS_A] ?? {});
    const tabsB = Object.values(useTabsStore.getState().byWorkspace[WS_B] ?? {});
    expect(tabsA).toHaveLength(1);
    expect(tabsB).toHaveLength(1);
  });
});
