/**
 * F2 / fileRename 키바인딩 통합 단위 테스트.
 *
 * 커버 범위:
 *   1. KEYBINDINGS 테이블에 F2 / "fileTreeFocus && !inputFocus" 가 정확히 등록됨.
 *   2. 글로벌 핸들러: activeWorkspaceId 없을 때 no-op.
 *   3. 글로벌 핸들러: 활성 경로가 rootAbsPath이면 no-op (루트 rename 금지).
 *   4. 글로벌 핸들러 정상 호출 → requestRename이 호출되고 requestId가 단조 증가.
 *   5. dispatcher: F2 키가 file tree 내부에서 발화하고 input 안에서는 발화 안 함.
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
import { registerFileCommands } from "../../../../src/renderer/commands/domains/file";
import {
  __resetChordStateForTests,
  handleGlobalKeyDown,
} from "../../../../src/renderer/keybindings/dispatcher";
import { useFilesStore } from "../../../../src/renderer/state/stores/files";
import { useActiveStore } from "../../../../src/renderer/state/stores/active";
import { COMMANDS } from "../../../../src/shared/keybindings/commands";
import { KEYBINDINGS } from "../../../../src/shared/keybindings/index";

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
    closest: (sel: string) =>
      sel === '[role="tree"]' ? ({} as HTMLElement) : null,
  } as unknown as HTMLElement;
}

/** INPUT 안의 요소 — inputFocus = true, fileTreeFocus = true (tree 안에 있는 input) */
function treeInputTarget(): HTMLElement {
  return {
    tagName: "INPUT",
    isContentEditable: false,
    closest: (sel: string) =>
      sel === '[role="tree"]' ? ({} as HTMLElement) : null,
  } as unknown as HTMLElement;
}

/** 트리 바깥 일반 div — fileTreeFocus = false */
function outsideTarget(): HTMLElement {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: () => null,
  } as unknown as HTMLElement;
}

const WS_ID = "ws-rename-test";
const ROOT = "/ws/project";
const FILE_PATH = "/ws/project/src/index.ts";

function resetStores() {
  // files 스토어: 새 인스턴스로 완전 초기화
  useFilesStore.setState({
    trees: new Map(),
    activeAbsPath: new Map(),
    pendingRenameRequest: null,
  });
  useActiveStore.setState({ activeWorkspaceId: null });
}

function initWorkspace() {
  // 트리 초기화
  useFilesStore.getState().initTree(WS_ID, ROOT, []);
  // 활성 경로 설정
  useFilesStore.getState().setActiveAbsPath(WS_ID, FILE_PATH);
  // 활성 워크스페이스 설정
  useActiveStore.setState({ activeWorkspaceId: WS_ID });
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
  resetStores();
});

afterEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
  resetStores();
});

// 1. KEYBINDINGS 테이블 검사
describe("KEYBINDINGS 테이블 — fileRename", () => {
  it("F2 primary 바인딩이 KEYBINDINGS에 등록돼 있다", () => {
    const decl = KEYBINDINGS.find(
      (k) => k.command === COMMANDS.fileRename && k.primary === "F2",
    );
    expect(decl).not.toBeUndefined();
  });

  it("when 조건이 정확히 'fileTreeFocus && !inputFocus' 이다", () => {
    const decl = KEYBINDINGS.find(
      (k) => k.command === COMMANDS.fileRename && k.primary === "F2",
    );
    expect(decl?.when).toBe("fileTreeFocus && !inputFocus");
  });
});

// 2. 글로벌 핸들러: wsId 없을 때 no-op
describe("fileRename 핸들러 — wsId 없을 때 no-op", () => {
  it("activeWorkspaceId가 null이면 requestRename을 호출하지 않는다", () => {
    const unregisters = registerFileCommands();
    try {
      // wsId 없음 (기본값 null)
      useFilesStore.getState().initTree(WS_ID, ROOT, []);
      useFilesStore.getState().setActiveAbsPath(WS_ID, FILE_PATH);
      // activeWorkspaceId는 null로 유지

      const e = makeEvent("F2", { code: "F2", target: treeTarget() });
      handleGlobalKeyDown(e);

      expect(useFilesStore.getState().pendingRenameRequest).toBeNull();
    } finally {
      unregisters.forEach((u) => u());
    }
  });
});

// 3. 글로벌 핸들러: rootAbsPath이면 no-op
describe("fileRename 핸들러 — root 경로이면 no-op", () => {
  it("activeAbsPath가 rootAbsPath와 같으면 requestRename을 호출하지 않는다", () => {
    const unregisters = registerFileCommands();
    try {
      initWorkspace();
      // 활성 경로를 루트로 변경
      useFilesStore.getState().setActiveAbsPath(WS_ID, ROOT);

      const e = makeEvent("F2", { code: "F2", target: treeTarget() });
      handleGlobalKeyDown(e);

      expect(useFilesStore.getState().pendingRenameRequest).toBeNull();
    } finally {
      unregisters.forEach((u) => u());
    }
  });
});

// 4. 글로벌 핸들러 정상 호출 → requestRename, requestId 단조 증가
describe("fileRename 핸들러 — 정상 흐름", () => {
  it("F2 → requestRename이 호출되고 pendingRenameRequest.absPath가 설정된다", () => {
    const unregisters = registerFileCommands();
    try {
      initWorkspace();

      const e = makeEvent("F2", { code: "F2", target: treeTarget() });
      handleGlobalKeyDown(e);

      const req = useFilesStore.getState().pendingRenameRequest;
      expect(req).not.toBeNull();
      expect(req?.absPath).toBe(FILE_PATH);
      expect(typeof req?.requestId).toBe("number");
    } finally {
      unregisters.forEach((u) => u());
    }
  });

  it("requestId는 호출마다 단조 증가한다", () => {
    const unregisters = registerFileCommands();
    try {
      initWorkspace();

      handleGlobalKeyDown(makeEvent("F2", { code: "F2", target: treeTarget() }));
      const req1 = useFilesStore.getState().pendingRenameRequest;

      // Esc 취소 시뮬레이션 후 재시도 (같은 경로 연속 rename)
      handleGlobalKeyDown(makeEvent("F2", { code: "F2", target: treeTarget() }));
      const req2 = useFilesStore.getState().pendingRenameRequest;

      expect(req1).not.toBeNull();
      expect(req2).not.toBeNull();
      expect(req2!.requestId).toBeGreaterThan(req1!.requestId);
    } finally {
      unregisters.forEach((u) => u());
    }
  });
});

// 5. dispatcher: when 조건에 의한 scoping
describe("dispatcher — F2 when 조건 scoping", () => {
  it("tree 안에서 F2 → file.rename 커맨드가 발화한다", () => {
    const renameFn = mock(() => {});
    registerCommand(COMMANDS.fileRename, renameFn as () => void);

    const e = makeEvent("F2", { code: "F2", target: treeTarget() });
    handleGlobalKeyDown(e);

    expect(renameFn).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("tree 안의 INPUT에서 F2 → 발화 안 함 (inputFocus가 true이므로)", () => {
    const renameFn = mock(() => {});
    registerCommand(COMMANDS.fileRename, renameFn as () => void);

    const e = makeEvent("F2", { code: "F2", target: treeInputTarget() });
    handleGlobalKeyDown(e);

    expect(renameFn).not.toHaveBeenCalled();
  });

  it("트리 바깥에서 F2 → 발화 안 함 (fileTreeFocus가 false이므로)", () => {
    const renameFn = mock(() => {});
    registerCommand(COMMANDS.fileRename, renameFn as () => void);

    const e = makeEvent("F2", { code: "F2", target: outsideTarget() });
    handleGlobalKeyDown(e);

    expect(renameFn).not.toHaveBeenCalled();
  });
});
