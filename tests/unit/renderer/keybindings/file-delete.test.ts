/**
 * Delete / Backspace fileDelete 키바인딩 단위 테스트.
 *
 * 커버 범위:
 *   1. KEYBINDINGS에 Delete/Backspace 가 정확히 등록됨 + when 표현 일치.
 *   2. 글로벌 핸들러: wsId 없으면 no-op.
 *   3. 글로벌 핸들러: activeAbsPath 없으면 no-op.
 *   4. 글로벌 핸들러: root absPath이면 no-op.
 *   5. helper: confirm cancel 시 unlink/rmdir 호출 안 함.
 *   6. helper: file vs dir에 따라 unlinkPath vs rmdirPath 분기.
 *   7. dispatcher: tree 안에서 Delete/Backspace 발화, input 안에서는 발화 안 함.
 *   8. 컨텍스트 메뉴 deleteTarget 회귀 없음 — isRoot 대상 삭제 시도 no-op.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Renderer IPC shim — 스토어 임포트 전에 설치
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
// IPC call spy — confirm-delete helper 내부의 unlinkPath / rmdirPath 추적용
// ---------------------------------------------------------------------------

type IpcCall = { channel: string; method: string; args: unknown };
const ipcCalls: IpcCall[] = [];

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    if (channel === "fs" && method === "readdir")
      return Promise.resolve({ ok: true as const, value: [] });
    return Promise.resolve({ ok: true as const, value: undefined });
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

// ---------------------------------------------------------------------------
// ShowConfirmDialog mock — confirm-delete now uses this instead of window.confirm.
// Default: resolves to true (confirm). Tests that need cancel can override.
// ---------------------------------------------------------------------------

let confirmDialogResult = true;
mock.module("../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: () => Promise.resolve(confirmDialogResult),
  ConfirmDialogRoot: () => null,
}));

// ---------------------------------------------------------------------------
// 임포트 (shim 설치 후)
// ---------------------------------------------------------------------------

import { registerFileCommands } from "../../../../src/renderer/commands/domains/file";
import {
  __resetCommandsForTests,
  registerCommand,
} from "../../../../src/renderer/commands/registry";
import {
  __resetChordStateForTests,
  handleGlobalKeyDown,
} from "../../../../src/renderer/keybindings/dispatcher";
import { confirmAndDeletePath } from "../../../../src/renderer/services/fs-mutations/confirm-delete";
import { useActiveStore } from "../../../../src/renderer/state/stores/active";
import { useFilesStore } from "../../../../src/renderer/state/stores/files";
import { useWorkspacesStore } from "../../../../src/renderer/state/stores/workspaces";
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

/** [role="tree"] 안의 DOM 요소 시뮬레이션 — fileTreeFocus=true, inputFocus=false */
function treeTarget(): HTMLElement {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: (sel: string) => (sel === '[role="tree"]' ? ({} as HTMLElement) : null),
  } as unknown as HTMLElement;
}

/** tree 안의 INPUT 요소 — inputFocus=true, fileTreeFocus=true */
function treeInputTarget(): HTMLElement {
  return {
    tagName: "INPUT",
    isContentEditable: false,
    closest: (sel: string) => (sel === '[role="tree"]' ? ({} as HTMLElement) : null),
  } as unknown as HTMLElement;
}

/** 트리 바깥 div — fileTreeFocus=false */
function outsideTarget(): HTMLElement {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: () => null,
  } as unknown as HTMLElement;
}

const WS_ID = "ws-delete-test";
const ROOT = "/ws/project";
const FILE_PATH = "/ws/project/src/index.ts";
const DIR_PATH = "/ws/project/src";

function resetStores() {
  useFilesStore.setState({
    trees: new Map(),
    selection: new Map(),
    pendingRenameRequest: null,
  });
  useActiveStore.setState({ activeWorkspaceId: null });
  useWorkspacesStore.setState({ workspaces: [] });
}

/**
 * Seed the workspaces store with a single workspace whose location.kind
 * drives the delete-routing branch in `confirmAndDeletePath`:
 *   - "local" → fs.trash
 *   - "ssh"   → fs.unlink / fs.removeAll
 */
function seedWorkspaceKind(kind: "local" | "ssh"): void {
  const location =
    kind === "local"
      ? { kind: "local" as const, rootPath: ROOT }
      : { kind: "ssh" as const, host: "dev.example.com", remotePath: ROOT };
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: WS_ID,
        name: "ws",
        rootPath: ROOT,
        location,
        colorTone: "default",
        pinned: false,
        tabs: [],
        sortOrder: 0,
        pinnedSortOrder: 0,
      } as never,
    ],
  });
}

function initWorkspace(activePath: string = FILE_PATH) {
  useFilesStore.getState().initTree(WS_ID, ROOT, []);
  useFilesStore.getState().setChildren(WS_ID, ROOT, [{ name: "src", type: "dir" }]);
  useFilesStore.getState().setChildren(WS_ID, DIR_PATH, [{ name: "index.ts", type: "file" }]);
  useFilesStore.getState().setSingleSelection(WS_ID, activePath);
  useActiveStore.setState({ activeWorkspaceId: WS_ID });
}

beforeEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
  resetStores();
  ipcCalls.length = 0;
  confirmDialogResult = true; // default: confirm accepts
  (globalThis as Record<string, unknown>).window = {
    ipc: {
      call: (channel: string, method: string, args: unknown) => {
        ipcCalls.push({ channel, method, args });
        if (channel === "fs" && method === "readdir") return Promise.resolve([]);
        return Promise.resolve(undefined);
      },
      cancel: () => {},
      listen: () => () => {},
      off: () => {},
    },
  };
});

afterEach(() => {
  __resetCommandsForTests();
  __resetChordStateForTests();
  resetStores();
  ipcCalls.length = 0;
});

// ---------------------------------------------------------------------------
// 1. KEYBINDINGS 테이블 검사
// ---------------------------------------------------------------------------

describe("KEYBINDINGS 테이블 — fileDelete", () => {
  // macOS Finder parity: Cmd+Backspace deletes (local = trash, SSH = permanent).
  // Plain Backspace must NOT delete — it is the universal "edit text" key
  // and a single-keystroke delete is too easy to trigger by accident.
  it("Cmd+Backspace primary 바인딩이 fileDelete 에 등록됨", () => {
    const decl = KEYBINDINGS.find(
      (k) => k.command === COMMANDS.fileDelete && k.primary === "Cmd+Backspace",
    );
    expect(decl).not.toBeUndefined();
  });

  it("Cmd+Backspace when 조건이 정확히 'fileTreeFocus && !inputFocus' 이다", () => {
    const decl = KEYBINDINGS.find(
      (k) => k.command === COMMANDS.fileDelete && k.primary === "Cmd+Backspace",
    );
    expect(decl?.when).toBe("fileTreeFocus && !inputFocus");
  });

  it("plain Backspace 는 fileDelete 에 바인딩되지 않는다", () => {
    const plainBackspace = KEYBINDINGS.find(
      (k) => k.command === COMMANDS.fileDelete && k.primary === "Backspace",
    );
    expect(plainBackspace).toBeUndefined();
  });

  it("plain Delete 는 fileDelete 에 바인딩되지 않는다", () => {
    const plainDelete = KEYBINDINGS.find(
      (k) => k.command === COMMANDS.fileDelete && k.primary === "Delete",
    );
    expect(plainDelete).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. 글로벌 핸들러: wsId 없으면 no-op
// ---------------------------------------------------------------------------

describe("fileDelete 핸들러 — wsId 없으면 no-op", () => {
  it("activeWorkspaceId가 null이면 IPC 호출 없음", async () => {
    const unregisters = registerFileCommands();
    try {
      // wsId를 null로 유지 (setState에서 activeWorkspaceId: null)
      initWorkspace();
      useActiveStore.setState({ activeWorkspaceId: null });

      const e = makeEvent("Backspace", {
        code: "Backspace",
        target: treeTarget(),
        metaKey: true,
      });
      handleGlobalKeyDown(e);
      // 비동기 핸들러가 있으므로 tick 대기
      await new Promise((r) => setTimeout(r, 0));

      expect(
        ipcCalls.filter(
          (c) =>
            c.method === "trash" ||
            c.method === "unlink" ||
            c.method === "rmdir" ||
            c.method === "removeAll",
        ),
      ).toHaveLength(0);
    } finally {
      unregisters.forEach((u) => {
        u();
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 글로벌 핸들러: activeAbsPath 없으면 no-op
// ---------------------------------------------------------------------------

describe("fileDelete 핸들러 — activeAbsPath 없으면 no-op", () => {
  it("activeAbsPath가 null이면 IPC 호출 없음", async () => {
    const unregisters = registerFileCommands();
    try {
      initWorkspace();
      // 활성 경로를 null로 리셋 — clearSelection으로 focus를 null로 만든다
      useFilesStore.getState().clearSelection(WS_ID);

      const e = makeEvent("Backspace", {
        code: "Backspace",
        target: treeTarget(),
        metaKey: true,
      });
      handleGlobalKeyDown(e);
      await new Promise((r) => setTimeout(r, 0));

      expect(
        ipcCalls.filter(
          (c) =>
            c.method === "trash" ||
            c.method === "unlink" ||
            c.method === "rmdir" ||
            c.method === "removeAll",
        ),
      ).toHaveLength(0);
    } finally {
      unregisters.forEach((u) => {
        u();
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 글로벌 핸들러: root absPath이면 no-op
// ---------------------------------------------------------------------------

describe("fileDelete 핸들러 — root 경로이면 no-op", () => {
  it("activeAbsPath가 rootAbsPath와 같으면 IPC 호출 없음", async () => {
    const unregisters = registerFileCommands();
    try {
      initWorkspace(ROOT); // 활성 경로 = 루트 (setSingleSelection(ROOT))

      const e = makeEvent("Backspace", {
        code: "Backspace",
        target: treeTarget(),
        metaKey: true,
      });
      handleGlobalKeyDown(e);
      await new Promise((r) => setTimeout(r, 0));

      expect(
        ipcCalls.filter(
          (c) =>
            c.method === "trash" ||
            c.method === "unlink" ||
            c.method === "rmdir" ||
            c.method === "removeAll",
        ),
      ).toHaveLength(0);
    } finally {
      unregisters.forEach((u) => {
        u();
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. helper: confirm cancel 시 unlink/rmdir 호출 안 함
// ---------------------------------------------------------------------------

describe("confirmAndDeletePath helper — confirm cancel", () => {
  it("confirm이 false를 반환하면 trash/unlink/rmdir/removeAll 모두 호출되지 않는다", async () => {
    confirmDialogResult = false;
    seedWorkspaceKind("local");

    const result = await confirmAndDeletePath(WS_ID, ROOT, FILE_PATH, "file");

    expect(result).toBe(false);
    expect(
      ipcCalls.filter(
        (c) =>
          c.method === "trash" ||
          c.method === "unlink" ||
          c.method === "rmdir" ||
          c.method === "removeAll",
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. helper: file vs dir 분기
// ---------------------------------------------------------------------------

describe("confirmAndDeletePath helper — workspace kind branching", () => {
  it("local workspace + nodeType='file' → fs.trash (recoverable via OS Trash)", async () => {
    confirmDialogResult = true;
    seedWorkspaceKind("local");

    await confirmAndDeletePath(WS_ID, ROOT, FILE_PATH, "file");

    const trashCall = ipcCalls.find((c) => c.channel === "fs" && c.method === "trash");
    expect(trashCall).toBeDefined();
    expect((trashCall?.args as { relPath: string }).relPath).toBe("src/index.ts");
    // No permanent-delete fallback on the local path.
    expect(ipcCalls.some((c) => c.method === "unlink")).toBe(false);
  });

  it("local workspace + nodeType='dir' → fs.trash (entire subtree to Trash)", async () => {
    confirmDialogResult = true;
    seedWorkspaceKind("local");
    ipcCalls.length = 0;

    await confirmAndDeletePath(WS_ID, ROOT, DIR_PATH, "dir");

    const trashCall = ipcCalls.find((c) => c.channel === "fs" && c.method === "trash");
    expect(trashCall).toBeDefined();
    expect((trashCall?.args as { relPath: string }).relPath).toBe("src");
    expect(ipcCalls.some((c) => c.method === "removeAll")).toBe(false);
  });

  it("ssh workspace + nodeType='file' → fs.unlink (no remote trash, permanent)", async () => {
    confirmDialogResult = true;
    seedWorkspaceKind("ssh");

    await confirmAndDeletePath(WS_ID, ROOT, FILE_PATH, "file");

    const unlinkCall = ipcCalls.find((c) => c.channel === "fs" && c.method === "unlink");
    expect(unlinkCall).toBeDefined();
    expect((unlinkCall?.args as { relPath: string }).relPath).toBe("src/index.ts");
    expect(ipcCalls.some((c) => c.method === "trash")).toBe(false);
  });

  it("ssh workspace + nodeType='dir' → fs.removeAll (recursive, permanent)", async () => {
    // The user has already confirmed the "this cannot be undone" prompt, so
    // removeDir goes straight to removeAll. rmdir was removed to silence the
    // noisy NOT_EMPTY / NOT_FOUND `ipcMain.handle` log on every non-trivial
    // folder delete.
    confirmDialogResult = true;
    seedWorkspaceKind("ssh");
    ipcCalls.length = 0;

    await confirmAndDeletePath(WS_ID, ROOT, DIR_PATH, "dir");

    const rmdirCall = ipcCalls.find((c) => c.channel === "fs" && c.method === "rmdir");
    expect(rmdirCall).toBeUndefined();
    const removeAllCall = ipcCalls.find((c) => c.channel === "fs" && c.method === "removeAll");
    expect(removeAllCall).toBeDefined();
    expect((removeAllCall?.args as { relPath: string }).relPath).toBe("src");
    expect(ipcCalls.some((c) => c.method === "trash")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. dispatcher: when 조건에 의한 scoping
// ---------------------------------------------------------------------------

describe("dispatcher — Cmd+Backspace when 조건 scoping", () => {
  it("tree 안에서 Cmd+Backspace → file.delete 커맨드가 발화한다", () => {
    const deleteFn = mock(() => {});
    registerCommand(COMMANDS.fileDelete, deleteFn as () => void);

    const e = makeEvent("Backspace", {
      code: "Backspace",
      target: treeTarget(),
      metaKey: true,
    });
    handleGlobalKeyDown(e);

    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("plain Backspace (modifier 없음) → 발화 안 함 (text-edit 키와 충돌 방지)", () => {
    const deleteFn = mock(() => {});
    registerCommand(COMMANDS.fileDelete, deleteFn as () => void);

    const e = makeEvent("Backspace", { code: "Backspace", target: treeTarget() });
    handleGlobalKeyDown(e);

    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("plain Delete → 발화 안 함", () => {
    const deleteFn = mock(() => {});
    registerCommand(COMMANDS.fileDelete, deleteFn as () => void);

    const e = makeEvent("Delete", { code: "Delete", target: treeTarget() });
    handleGlobalKeyDown(e);

    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("tree 안의 INPUT에서 Cmd+Backspace → 발화 안 함 (inputFocus=true)", () => {
    const deleteFn = mock(() => {});
    registerCommand(COMMANDS.fileDelete, deleteFn as () => void);

    const e = makeEvent("Backspace", {
      code: "Backspace",
      target: treeInputTarget(),
      metaKey: true,
    });
    handleGlobalKeyDown(e);

    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("트리 바깥에서 Cmd+Backspace → 발화 안 함 (fileTreeFocus=false)", () => {
    const deleteFn = mock(() => {});
    registerCommand(COMMANDS.fileDelete, deleteFn as () => void);

    const e = makeEvent("Backspace", {
      code: "Backspace",
      target: outsideTarget(),
      metaKey: true,
    });
    handleGlobalKeyDown(e);

    expect(deleteFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. 컨텍스트 메뉴 deleteTarget 회귀 검증 — isRoot이면 no-op
// ---------------------------------------------------------------------------

describe("use-file-tree-actions 회귀 — isRoot 대상 no-op", () => {
  it("isRoot=true이면 delete 호출 시 IPC 없음", async () => {
    const { useFileTreeActions } = await import(
      "../../../../src/renderer/components/files/hooks/use-file-tree-actions"
    );

    const actions = useFileTreeActions({
      workspaceId: WS_ID,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: ROOT, type: "dir" as const, isRoot: true }],
      startCreate: () => {},
      startRename: () => {},
    });

    ipcCalls.length = 0;
    await actions.delete();

    expect(
      ipcCalls.filter(
        (c) =>
          c.method === "trash" ||
          c.method === "unlink" ||
          c.method === "rmdir" ||
          c.method === "removeAll",
      ),
    ).toHaveLength(0);
  });
});
