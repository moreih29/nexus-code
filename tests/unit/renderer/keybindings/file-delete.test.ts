/**
 * Unit tests for the Delete / Backspace fileDelete keybinding.
 *
 * Coverage:
 *   1. global handler: no-op without a wsId.
 *   2. global handler: no-op without an activeAbsPath.
 *   3. global handler: no-op for the root absPath.
 *   4. helper: no unlink/rmdir call when the confirm is cancelled.
 *   5. helper: unlinkPath vs rmdirPath branch depending on file vs dir.
 *   6. dispatcher: fires Delete/Backspace inside the tree, not inside an input.
 *   7. no regression in the context menu deleteTarget — deleting an isRoot target is a no-op.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Renderer IPC shim — installed before the store import
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// IPC call spy — tracks unlinkPath / rmdirPath inside the confirm-delete helper
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
// Imports (after the shim is installed)
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

/** Simulates a DOM element inside [role="tree"] — fileTreeFocus=true, inputFocus=false */
function treeTarget(): HTMLElement {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: (sel: string) => (sel === '[role="tree"]' ? ({} as HTMLElement) : null),
  } as unknown as HTMLElement;
}

/** An INPUT element inside the tree — inputFocus=true, fileTreeFocus=true */
function treeInputTarget(): HTMLElement {
  return {
    tagName: "INPUT",
    isContentEditable: false,
    closest: (sel: string) => (sel === '[role="tree"]' ? ({} as HTMLElement) : null),
  } as unknown as HTMLElement;
}

/** A div outside the tree — fileTreeFocus=false */
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
  setPlatformForTests(null);
  __resetCommandsForTests();
  __resetChordStateForTests();
  resetStores();
  ipcCalls.length = 0;
});

// ---------------------------------------------------------------------------
// 3. global handler: no-op for the root absPath
// ---------------------------------------------------------------------------

describe("fileDelete 핸들러 — root 경로이면 no-op", () => {
  it("activeAbsPath가 rootAbsPath와 같으면 IPC 호출 없음", async () => {
    const unregisters = registerFileCommands();
    try {
      initWorkspace(ROOT); // active path = root (setSingleSelection(ROOT))

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
// 4. helper: no unlink/rmdir call when the confirm is cancelled
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
// 5. helper: file vs dir branch
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
// 6. dispatcher: scoping by the when condition
// ---------------------------------------------------------------------------

describe("dispatcher — Cmd+Backspace when 조건 scoping", () => {
  // macOS Finder parity: Cmd+Backspace deletes (local = trash, SSH = permanent).
  // Plain Backspace must NOT delete — it is the universal "edit text" key
  // and a single-keystroke delete is too easy to trigger by accident.
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

  it("plain Delete → macOS 에서는 발화 안 함", () => {
    setPlatformForTests("darwin");
    const deleteFn = mock(() => {});
    registerCommand(COMMANDS.fileDelete, deleteFn as () => void);

    const e = makeEvent("Delete", { code: "Delete", target: treeTarget() });
    handleGlobalKeyDown(e);

    expect(deleteFn).not.toHaveBeenCalled();
  });

  // Windows and Linux file managers delete with Delete.
  it("plain Delete → Windows·Linux 에서는 tree 안에서 발화한다", () => {
    for (const platform of ["win32", "linux"] as const) {
      setPlatformForTests(platform);
      const deleteFn = mock(() => {});
      registerCommand(COMMANDS.fileDelete, deleteFn as () => void);

      const e = makeEvent("Delete", { code: "Delete", target: treeTarget() });
      handleGlobalKeyDown(e);
      expect(deleteFn).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(true);

      const typed = makeEvent("Delete", { code: "Delete", target: treeInputTarget() });
      handleGlobalKeyDown(typed);
      const outside = makeEvent("Delete", { code: "Delete", target: outsideTarget() });
      handleGlobalKeyDown(outside);
      expect(deleteFn).toHaveBeenCalledTimes(1);
      __resetCommandsForTests();
    }
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
// 7. context menu deleteTarget regression check — no-op for isRoot
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
