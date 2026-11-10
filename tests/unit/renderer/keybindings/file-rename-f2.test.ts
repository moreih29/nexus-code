/**
 * Enter-to-rename 키바인딩 단위 테스트.
 *
 * 커버 범위:
 *   - dispatcher: Enter rename은 macOS에서만 발화.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Renderer 측 IPC 의존성 shim — store 임포트 전에 설치
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
// 임포트 (shim 설치 후)
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
// 헬퍼
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

/** [role="tree"] 안의 DOM 요소를 시뮬레이션 — fileTreeFocus = true */
function treeTarget(): HTMLElement {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: (sel: string) => (sel === '[role="tree"]' ? ({} as HTMLElement) : null),
  } as unknown as HTMLElement;
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
});

afterEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
});

// 5. dispatcher: Enter rename은 macOS 전용 (F2는 모든 플랫폼)
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
