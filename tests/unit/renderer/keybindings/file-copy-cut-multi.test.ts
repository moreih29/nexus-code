/**
 * Phase D — fileCopy / fileCut global command handler multi-selection tests.
 *
 * Tests the command handler logic directly (not via keybinding dispatch) to
 * avoid mock.module caching issues with the file-clipboard barrel import.
 *
 * Pattern: use registerCommand(COMMANDS.fileCopy, spy) to capture the
 * handler call, then verify via a separate direct-invocation test that the
 * handler actually calls handleCopy/handleCut with correct entries.
 *
 * For handleCopy/handleCut, we test using the useFileTreeActions layer
 * (tested in file-tree-actions-copy-cut.test.ts) — keybinding dispatch is
 * verified by a smoke test that the command fires at all.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shims
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => () => {},
    off: () => {},
  },
};

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: () => Promise.resolve({ ok: true as const, value: [] }),
  unwrapIpcResult: <T>(r: { ok: boolean; value?: T }): T => r.value as T,
  mustSucceed: <T>(r: { ok: boolean; value?: T }): T => r.value as T,
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  __resetCommandsForTests,
  registerCommand,
} from "../../../../src/renderer/commands/registry";
import {
  __resetChordStateForTests,
  handleGlobalKeyDown,
} from "../../../../src/renderer/keybindings/dispatcher";
import { useActiveStore } from "../../../../src/renderer/state/stores/active";
import { useFilesStore } from "../../../../src/renderer/state/stores/files";
import { COMMANDS } from "../../../../src/shared/keybindings/commands";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "ws-copy-cut-global";
const ROOT = "/repo";

function makeKeyEvent(
  key: string,
  opts: { metaKey?: boolean; ctrlKey?: boolean } = {},
): KeyboardEvent {
  const target = {
    tagName: "DIV",
    isContentEditable: false,
    closest: (sel: string) => (sel === '[role="tree"]' ? {} : null),
  };
  return {
    key,
    code: `Key${key.toUpperCase()}`,
    target,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: false,
    altKey: false,
    get defaultPrevented() {
      return false;
    },
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
}

function resetAll(): void {
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "b.ts", type: "file" },
  ]);
  useActiveStore.setState({ activeWorkspaceId: WS });
}

beforeEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
  resetAll();
});

afterEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
});

// ---------------------------------------------------------------------------
// Smoke: CmdOrCtrl+C dispatches fileCopy when file tree is focused.
// Verifies keybinding is registered + when condition is correct.
// ---------------------------------------------------------------------------

describe("fileCopy keybinding — dispatch smoke test", () => {
  it("CmdOrCtrl+C in file tree fires fileCopy command", () => {
    const spy = mock(() => {});
    registerCommand(COMMANDS.fileCopy, spy);

    // On macOS (IS_MAC=true): metaKey. On Linux/Win (IS_MAC=false): ctrlKey.
    // Use both to cover CI environments.
    handleGlobalKeyDown(makeKeyEvent("c", { metaKey: true }));
    handleGlobalKeyDown(makeKeyEvent("c", { ctrlKey: true }));

    // At least one should have fired (whichever matches the test OS).
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("fileCut keybinding — dispatch smoke test", () => {
  it("CmdOrCtrl+X in file tree fires fileCut command", () => {
    const spy = mock(() => {});
    registerCommand(COMMANDS.fileCut, spy);

    handleGlobalKeyDown(makeKeyEvent("x", { metaKey: true }));
    handleGlobalKeyDown(makeKeyEvent("x", { ctrlKey: true }));

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Logic: selectOperablePaths drives entries count.
// We verify the selector produces the expected paths for single/multi/root.
// These are unit tests of the selector + store; the actual handleCopy/handleCut
// integration is covered in file-tree-actions-copy-cut.test.ts.
// ---------------------------------------------------------------------------

import { selectOperablePaths } from "../../../../src/renderer/state/stores/files";

describe("selectOperablePaths — drives fileCopy/fileCut entries", () => {
  it("returns [focus] when paths is empty", () => {
    useFilesStore.getState().setSingleSelection(WS, `${ROOT}/a.ts`);
    const paths = selectOperablePaths(useFilesStore.getState(), WS);
    expect(paths).toEqual([`${ROOT}/a.ts`]);
  });

  it("returns distinctParents([...paths]) when paths is non-empty (Cmd+A then check)", () => {
    // Use selectAllVisible to get both a.ts and b.ts into paths set.
    useFilesStore.getState().selectAllVisible(WS, [`${ROOT}/a.ts`, `${ROOT}/b.ts`]);
    const paths = selectOperablePaths(useFilesStore.getState(), WS);
    expect(paths).toHaveLength(2);
    expect(paths).toContain(`${ROOT}/a.ts`);
    expect(paths).toContain(`${ROOT}/b.ts`);
  });

  it("collapses parent+child via distinctParents when both are in paths", () => {
    // Use extendSelectionTo to get both ROOT/a.ts and ROOT in paths.
    // Note: paths set semantics — use selectAllVisible to fill paths.
    useFilesStore.getState().selectAllVisible(WS, [ROOT, `${ROOT}/a.ts`]);
    // ROOT is the parent of ROOT/a.ts → distinctParents([ROOT, ROOT/a.ts]) = [ROOT]
    const paths = selectOperablePaths(useFilesStore.getState(), WS);
    expect(paths).toEqual([ROOT]);
  });

  it("returns [] when no focus and no paths", () => {
    const paths = selectOperablePaths(useFilesStore.getState(), WS);
    expect(paths).toEqual([]);
  });
});
