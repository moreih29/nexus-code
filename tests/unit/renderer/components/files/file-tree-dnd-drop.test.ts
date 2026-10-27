/**
 * dropFilePaths — the move/copy half of the file-tree drop target.
 *
 * Drives the real function with an IPC spy, so the assertions cover the
 * fs calls movePath / copyPathWithAutoRename issue and the summary toast.
 *
 * Covers:
 *  - Single path move: one rename, no summary toast.
 *  - Multi-path move / copy: one call per path, info summary toast.
 *  - Self-drop guard: every path already in the target dir → no-op; a
 *    partial self-drop skips those paths and leaves them out of the count.
 *  - Cycle guard: folder dropped into itself or a descendant → warning.
 *  - Partial failure: error summary names the first failed item.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

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

// ---------------------------------------------------------------------------
// IPC spy
// ---------------------------------------------------------------------------

type IpcCall = { channel: string; method: string; args: Record<string, unknown> };
const ipcCalls: IpcCall[] = [];
/** fromRelPath whose rename / copyFile fails with PERMISSION_DENIED. */
let failFromRelPath: string | null = null;

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: Record<string, unknown>) => {
    ipcCalls.push({ channel, method, args });
    if ((method === "rename" || method === "copyFile") && args.fromRelPath === failFromRelPath)
      return Promise.resolve({
        ok: false as const,
        error: { message: `PERMISSION_DENIED: /repo/${failFromRelPath}` },
      });
    if (method === "readdir") return Promise.resolve({ ok: true as const, value: [] });
    return Promise.resolve({ ok: true as const, value: undefined });
  },
  unwrapIpcResult: <T>(r: { ok: boolean; value?: T; error?: { message?: string } }): T => {
    if (!r.ok) throw new Error(r.error?.message ?? "ipc error");
    return r.value as T;
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

// ---------------------------------------------------------------------------
// Toast spy
// ---------------------------------------------------------------------------

const toastCalls: { kind: string; message: string }[] = [];
mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: { kind: string; message: string }) => {
    toastCalls.push(input);
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { dropFilePaths } from "../../../../../src/renderer/components/files/hooks/use-file-tree-drop-target";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "ws-dnd-drop-test";
const ROOT = "/repo";

function drop(filePaths: string[], dir: string, copy: boolean): Promise<void> {
  return dropFilePaths({ workspaceId: WS, workspaceRootPath: ROOT, filePaths, dir, copy });
}

function calls(method: string): Record<string, unknown>[] {
  return ipcCalls.filter((c) => c.method === method).map((c) => c.args);
}

beforeEach(() => {
  ipcCalls.length = 0;
  toastCalls.length = 0;
  failFromRelPath = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dropFilePaths — move", () => {
  it("moves one file without a summary toast", async () => {
    await drop([`${ROOT}/a.ts`], `${ROOT}/src`, false);
    expect(calls("rename")).toEqual([
      { workspaceId: WS, fromRelPath: "a.ts", toRelPath: "src/a.ts", overwrite: false },
    ]);
    expect(toastCalls).toEqual([]);
  });

  it("moves every path and summarizes", async () => {
    await drop([`${ROOT}/a.ts`, `${ROOT}/b.ts`], `${ROOT}/src`, false);
    expect(calls("rename").map((a) => a.toRelPath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(toastCalls).toEqual([{ kind: "info", message: "Moved 2 items" }]);
  });
});

describe("dropFilePaths — copy", () => {
  it("copies every path and summarizes", async () => {
    await drop([`${ROOT}/a.ts`, `${ROOT}/b.ts`], `${ROOT}/src`, true);
    expect(calls("copyFile")).toEqual([
      { workspaceId: WS, fromRelPath: "a.ts", toRelPath: "src/a.ts" },
      { workspaceId: WS, fromRelPath: "b.ts", toRelPath: "src/b.ts" },
    ]);
    expect(toastCalls).toEqual([{ kind: "info", message: "Copied 2 items" }]);
  });

  it("copies into the source folder itself", async () => {
    await drop([`${ROOT}/src/a.ts`], `${ROOT}/src`, true);
    expect(calls("copyFile")).toHaveLength(1);
  });
});

describe("dropFilePaths — self-drop guard", () => {
  it("does nothing when every path is already in the target dir", async () => {
    await drop([`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], `${ROOT}/src`, false);
    expect(ipcCalls).toEqual([]);
    expect(toastCalls).toEqual([]);
  });

  it("skips paths already in the target dir and leaves them out of the count", async () => {
    await drop([`${ROOT}/a.ts`, `${ROOT}/src/b.ts`], `${ROOT}/src`, false);
    expect(calls("rename").map((a) => a.fromRelPath)).toEqual(["a.ts"]);
    // One item attempted, so no summary.
    expect(toastCalls).toEqual([]);
  });
});

describe("dropFilePaths — cycle guard", () => {
  it("warns when a folder is dropped into itself", async () => {
    await drop([`${ROOT}/src`, `${ROOT}/a.ts`], `${ROOT}/src`, false);
    expect(calls("rename")).toEqual([]);
    expect(toastCalls).toEqual([
      { kind: "warning", message: "Cannot drop a folder into itself or one of its subfolders." },
    ]);
  });

  it("warns when a folder is dropped into a descendant", async () => {
    await drop([`${ROOT}/src`], `${ROOT}/src/sub`, true);
    expect(calls("copyFile")).toEqual([]);
    expect(toastCalls.map((t) => t.kind)).toEqual(["warning"]);
  });
});

describe("dropFilePaths — partial failure", () => {
  it("names the first item that failed to move", async () => {
    failFromRelPath = "a.ts";
    await drop([`${ROOT}/a.ts`, `${ROOT}/b.ts`], `${ROOT}/src`, false);
    expect(calls("rename")).toHaveLength(2);
    expect(toastCalls).toEqual([
      { kind: "error", message: "Permission denied while moving item." },
      { kind: "error", message: `Moved 1 of 2 items. Couldn't move "a.ts".` },
    ]);
  });

  it("names the first item that failed to copy", async () => {
    failFromRelPath = "b.ts";
    await drop([`${ROOT}/a.ts`, `${ROOT}/b.ts`], `${ROOT}/src`, true);
    expect(toastCalls.at(-1)).toEqual({
      kind: "error",
      message: `Copied 1 of 2 items. Couldn't copy "b.ts".`,
    });
  });
});
