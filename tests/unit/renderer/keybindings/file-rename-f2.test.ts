/**
 * Unit tests for the Enter-to-rename keybinding.
 *
 * Coverage:
 *   - dispatcher: Enter rename fires only on macOS.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Renderer-side IPC dependency shim — installed before the store import
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
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

// ---------------------------------------------------------------------------
// Imports (after the shim is installed)
// ---------------------------------------------------------------------------

import {
  __resetCommandsForTests,
  registerCommand,
} from "../../../../src/renderer/commands/registry";
import {
  __resetChordStateForTests,
  handleGlobalKeyDown,
} from "../../../../src/renderer/keybindings/dispatcher";
import { setPlatformForTests } from "../../../../src/renderer/utils/platform";
import { COMMANDS } from "../../../../src/shared/keybindings/commands";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  key: string,
  opts: {
    code?: string;
    target?: unknown;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  } = {},
): KeyboardEvent {
  let prevented = false;
  return {
    key,
    code: opts.code ?? key,
    target: opts.target ?? null,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  } as unknown as KeyboardEvent;
}

/** Simulates a DOM element inside [role="tree"] — fileTreeFocus = true */
function treeTarget(): HTMLElement {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: (sel: string) => (sel === '[role="tree"]' ? ({} as HTMLElement) : null),
  } as unknown as HTMLElement;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
});

afterEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
});

// 5. dispatcher: Enter rename is macOS only (F2 works on all platforms)
describe("dispatcher — Enter rename is macOS-only", () => {
  afterEach(() => setPlatformForTests(null));

  for (const [platform, calls] of [
    ["darwin", 1],
    ["win32", 0],
  ] as const) {
    it(`Enter in the tree fires file.renameByEnter ${calls} time(s) on ${platform}`, () => {
      setPlatformForTests(platform);
      const renameFn = mock(() => {});
      registerCommand(COMMANDS.fileRenameByEnter, renameFn as () => void);

      handleGlobalKeyDown(makeEvent("Enter", { code: "Enter", target: treeTarget() }));

      expect(renameFn).toHaveBeenCalledTimes(calls);
    });
  }
});
