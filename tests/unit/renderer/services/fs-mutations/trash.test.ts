/**
 * trashPath — renderer service tests.
 *
 * Covers the happy path (IPC dispatch + parent refresh), out-of-workspace
 * guard, and the error toast path. The workspace-kind branching is owned
 * by confirmAndDeletePath; this layer assumes the caller already decided
 * trash is the right path.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const toastCalls: Array<{ kind: string; message: string }> = [];

mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: { kind: string; message: string }) => {
    toastCalls.push(input);
  },
}));

type IpcCall = { channel: string; method: string; args: unknown };
const ipcCalls: IpcCall[] = [];
let rejectNext: Error | null = null;

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    if (rejectNext) {
      const err = rejectNext;
      rejectNext = null;
      return Promise.reject(err);
    }
    if (channel === "fs" && method === "readdir")
      return Promise.resolve({ ok: true as const, value: [] });
    return Promise.resolve({ ok: true as const, value: undefined });
  },
  unwrapIpcResult: <T>(result: { ok: boolean; value: T }) => {
    if (result.ok) return result.value;
    throw new Error("IPC error");
  },
  mustSucceed: <T>(result: { ok: boolean; value: T }) => {
    if (result.ok) return result.value;
    throw new Error("IPC error");
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

const { trashPath } = await import("../../../../../src/renderer/services/fs-mutations");
const { useFilesStore } = await import("../../../../../src/renderer/state/stores/files");

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const ROOT = "/repo";

function resetTree(): void {
  useFilesStore.setState({ trees: new Map(), activeAbsPath: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "dir", type: "dir" },
  ]);
}

beforeEach(() => {
  toastCalls.length = 0;
  ipcCalls.length = 0;
  rejectNext = null;
  resetTree();
});

describe("trashPath", () => {
  it("sends fs.trash with the workspace-relative path and refreshes the parent", async () => {
    const ok = await trashPath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      absPath: "/repo/a.ts",
      nodeType: "file",
    });

    expect(ok).toBe(true);
    const trashCall = ipcCalls.find((c) => c.method === "trash");
    expect(trashCall).toEqual({
      channel: "fs",
      method: "trash",
      args: { workspaceId: WS, relPath: "a.ts" },
    });
    // Parent (root) is reloaded after success.
    expect(ipcCalls.some((c) => c.method === "readdir")).toBe(true);
    expect(toastCalls).toHaveLength(0);
  });

  it("refuses a path outside the workspace root", async () => {
    const ok = await trashPath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      absPath: "/other/escapee.ts",
      nodeType: "file",
    });

    expect(ok).toBe(false);
    expect(ipcCalls.some((c) => c.method === "trash")).toBe(false);
    expect(toastCalls).toHaveLength(1);
  });

  it("returns false and toasts on IPC failure (folder wording)", async () => {
    rejectNext = new Error("PERMISSION_DENIED: /repo/dir");

    const ok = await trashPath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      absPath: "/repo/dir",
      nodeType: "dir",
    });

    expect(ok).toBe(false);
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.kind).toBe("error");
    // Wording branches on nodeType — folder copy must mention "folder".
    expect(toastCalls[0]?.message.toLowerCase()).toContain("folder");
  });
});
