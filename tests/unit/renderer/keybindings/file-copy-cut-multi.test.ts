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
 * verified per platform by checking the command fires once.
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
import { setPlatformForTests } from "../../../../src/renderer/utils/platform";
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
// Dispatch: CmdOrCtrl+C / +X fire fileCopy / fileCut in the focused tree.
// Verifies keybinding is registered + when condition is correct.
// ---------------------------------------------------------------------------

describe("fileCopy / fileCut keybindings — dispatch", () => {
  afterEach(() => setPlatformForTests(null));

  // CmdOrCtrl is ⌘ on macOS and Ctrl elsewhere; the other modifier is not it.
  const cases = [
    { platform: "darwin", mod: "metaKey", other: "ctrlKey" },
    { platform: "win32", mod: "ctrlKey", other: "metaKey" },
  ] as const;

  for (const { platform, mod, other } of cases) {
    it(`CmdOrCtrl+C / CmdOrCtrl+X in the file tree fire on ${platform}`, () => {
      setPlatformForTests(platform);
      const copy = mock(() => {});
      const cut = mock(() => {});
      registerCommand(COMMANDS.fileCopy, copy);
      registerCommand(COMMANDS.fileCut, cut);

      handleGlobalKeyDown(makeKeyEvent("c", { [mod]: true }));
      handleGlobalKeyDown(makeKeyEvent("c", { [other]: true }));
      handleGlobalKeyDown(makeKeyEvent("x", { [mod]: true }));
      handleGlobalKeyDown(makeKeyEvent("x", { [other]: true }));

      expect(copy).toHaveBeenCalledTimes(1);
      expect(cut).toHaveBeenCalledTimes(1);
    });
  }
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
