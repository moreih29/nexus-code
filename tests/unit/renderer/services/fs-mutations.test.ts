import { beforeEach, describe, expect, it, mock } from "bun:test";

const toastCalls: Array<{ kind: string; message: string }> = [];

mock.module("../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: { kind: string; message: string }) => {
    toastCalls.push(input);
  },
}));

type IpcCall = { channel: string; method: string; args: unknown };
const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const ROOT = "/repo";
const ipcCalls: IpcCall[] = [];
let rejectNext: Error | null = null;

mock.module("../../../../src/renderer/ipc/client", () => ({
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
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

function installWindow(): void {
  (globalThis as { window?: unknown }).window = {
    ipc: {
      call: (channel: string, method: string, args: unknown) => {
        ipcCalls.push({ channel, method, args });
        if (rejectNext) {
          const err = rejectNext;
          rejectNext = null;
          return Promise.reject(err);
        }
        if (channel === "fs" && method === "readdir") return Promise.resolve([]);
        return Promise.resolve(undefined);
      },
      cancel: () => {},
      listen: () => () => {},
      off: () => {},
    },
    host: { platform: "darwin" },
  };
}

const { renamePath, rmdirPath, unlinkPath } = await import(
  "../../../../src/renderer/services/fs-mutations"
);
const { toFsToast } = await import("../../../../src/renderer/services/fs-mutations/errors");
const { useFilesStore } = await import("../../../../src/renderer/state/stores/files");

function resetTree(): void {
  useFilesStore.setState({ trees: new Map(), activeAbsPath: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "dir", type: "dir" },
  ]);
}

describe("fs-mutations services", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    toastCalls.length = 0;
    rejectNext = null;
    installWindow();
    resetTree();
  });

  it("exports unlink/rmdir/rename methods that call the fs IPC contract", async () => {
    await unlinkPath({ workspaceId: WS, workspaceRootPath: ROOT, absPath: `${ROOT}/a.ts` });
    await rmdirPath({ workspaceId: WS, workspaceRootPath: ROOT, absPath: `${ROOT}/dir` });
    await renamePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      absPath: `${ROOT}/a.ts`,
      newName: "b.ts",
    });

    expect(ipcCalls.filter((call) => call.method !== "readdir")).toEqual([
      { channel: "fs", method: "unlink", args: { workspaceId: WS, relPath: "a.ts" } },
      { channel: "fs", method: "rmdir", args: { workspaceId: WS, relPath: "dir" } },
      {
        channel: "fs",
        method: "rename",
        args: { workspaceId: WS, fromRelPath: "a.ts", toRelPath: "b.ts" },
      },
    ]);
  });

  it("maps NOT_EMPTY, ALREADY_EXISTS, and CROSS_DEVICE to user-facing toasts", () => {
    toFsToast(new Error("NOT_EMPTY: /repo/dir"), { fallback: "fallback" });
    toFsToast(new Error("ALREADY_EXISTS: /repo/b.ts"), { fallback: "fallback" });
    toFsToast(new Error("CROSS_DEVICE: /repo/a.ts"), { fallback: "fallback" });

    expect(toastCalls.map((call) => call.message)).toEqual([
      "Folder is not empty.",
      "Already exists.",
      "Can't move across filesystems.",
    ]);
  });

  it("keeps rename input open when ALREADY_EXISTS fails", async () => {
    rejectNext = new Error("ALREADY_EXISTS: /repo/b.ts");

    const ok = await renamePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      absPath: `${ROOT}/a.ts`,
      newName: "b.ts",
    });

    expect(ok).toBe(false);
    expect(toastCalls.map((call) => call.message)).toEqual([
      "A file or folder with that name already exists.",
    ]);
  });
});
