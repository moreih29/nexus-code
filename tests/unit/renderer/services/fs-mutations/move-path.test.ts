import { beforeEach, describe, expect, it, mock } from "bun:test";

const toastCalls: Array<{ kind: string; message: string }> = [];

mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: { kind: string; message: string }) => {
    toastCalls.push(input);
  },
}));

let confirmReply: boolean = true;
const confirmReplace = mock(() => Promise.resolve(confirmReply));
mock.module("../../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: confirmReplace,
}));

type IpcCall = { channel: string; method: string; args: unknown };
const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const ROOT = "/repo";
const ipcCalls: IpcCall[] = [];
let rejectNext: Error | null = null;
let readdirEntries: Array<{ name: string; type: "file" | "dir" | "symlink" }> = [];

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    if (channel === "fs" && method === "readdir")
      return Promise.resolve({ ok: true as const, value: readdirEntries });
    if (rejectNext) {
      const err = rejectNext;
      rejectNext = null;
      return Promise.reject(err);
    }
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
  unwrapGitResult: <T>(result: { ok: boolean; value: T }) => {
    if (result.ok) return result.value;
    throw new Error("Git IPC error");
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

const { movePath } = await import("../../../../../src/renderer/services/fs-mutations");
const { useFilesStore } = await import("../../../../../src/renderer/state/stores/files");

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

function resetTree(): void {
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "dir", type: "dir" },
    { name: "other", type: "dir" },
  ]);
  useFilesStore.getState().setChildren(WS, `${ROOT}/dir`, [{ name: "nested.ts", type: "file" }]);
  useFilesStore.getState().setChildren(WS, `${ROOT}/other`, []);
}

describe("movePath", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    toastCalls.length = 0;
    rejectNext = null;
    readdirEntries = [];
    confirmReply = true;
    confirmReplace.mockClear();
    installWindow();
    resetTree();
  });

  it("emits fs.rename IPC with correct fromRelPath and toRelPath for cross-directory move", async () => {
    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/dir/nested.ts`,
      dstDirAbsPath: `${ROOT}/other`,
    });

    expect(ok).toBe(true);

    const renameCalls = ipcCalls.filter((c) => c.method === "rename");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]).toEqual({
      channel: "fs",
      method: "rename",
      args: {
        workspaceId: WS,
        fromRelPath: "dir/nested.ts",
        toRelPath: "other/nested.ts",
        overwrite: false,
      },
    });

    const readdirCalls = ipcCalls.filter((c) => c.method === "readdir");
    expect(readdirCalls).toHaveLength(3);
  });

  it("returns true without IPC when source and destination are the same directory", async () => {
    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/a.ts`,
      dstDirAbsPath: ROOT,
    });

    expect(ok).toBe(true);
    expect(ipcCalls).toHaveLength(0);
  });

  it("returns false with not-found toast when source does not exist", async () => {
    rejectNext = new Error("NOT_FOUND: /repo/missing.ts");

    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/missing.ts`,
      dstDirAbsPath: `${ROOT}/other`,
    });

    expect(ok).toBe(false);
    expect(toastCalls.map((c) => c.message)).toEqual(["Item not found."]);
  });

  it("prompts to replace when the destination has a colliding name; calls rename with overwrite=true on confirm", async () => {
    readdirEntries = [{ name: "nested.ts", type: "file" }];
    confirmReply = true;

    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/dir/nested.ts`,
      dstDirAbsPath: `${ROOT}/other`,
    });

    expect(ok).toBe(true);
    const renameCalls = ipcCalls.filter((c) => c.method === "rename");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0].args).toEqual({
      workspaceId: WS,
      fromRelPath: "dir/nested.ts",
      toRelPath: "other/nested.ts",
      overwrite: true,
    });
    expect(toastCalls).toEqual([]);
  });

  it("returns false and does not call rename when the user cancels the replace prompt", async () => {
    readdirEntries = [{ name: "nested.ts", type: "file" }];
    confirmReply = false;

    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/dir/nested.ts`,
      dstDirAbsPath: `${ROOT}/other`,
    });

    expect(ok).toBe(false);
    expect(ipcCalls.filter((c) => c.method === "rename")).toHaveLength(0);
    expect(toastCalls).toEqual([]);
  });

  it.each([
    true,
    false,
  ])("asks before retrying a collision found by the destination filesystem (confirmed %s)", async (confirmed) => {
    readdirEntries = [{ name: "NESTED.ts", type: "file" }];
    rejectNext = new Error("ALREADY_EXISTS: /repo/other/nested.ts");
    confirmReply = confirmed;

    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/dir/nested.ts`,
      dstDirAbsPath: `${ROOT}/other`,
    });

    expect(ok).toBe(confirmed);
    expect(confirmReplace).toHaveBeenCalledTimes(1);
    const renames = ipcCalls.filter((call) => call.method === "rename");
    expect(renames.map(({ args }) => args)).toEqual(
      (confirmed ? [false, true] : [false]).map((overwrite) =>
        expect.objectContaining({
          fromRelPath: "dir/nested.ts",
          toRelPath: "other/nested.ts",
          overwrite,
        }),
      ),
    );
    expect(toastCalls).toEqual([]);
  });

  it("returns false with out-of-workspace toast when srcAbsPath is outside workspace", async () => {
    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: "/outside/file.txt",
      dstDirAbsPath: `${ROOT}/other`,
    });

    expect(ok).toBe(false);
    expect(toastCalls.map((c) => c.message)).toEqual(["This path is outside the workspace."]);
    expect(ipcCalls.filter((c) => c.method === "rename")).toHaveLength(0);
  });

  it("returns false with out-of-workspace toast when dstDirAbsPath is outside workspace", async () => {
    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/a.ts`,
      dstDirAbsPath: "/outside",
    });

    expect(ok).toBe(false);
    expect(toastCalls.map((c) => c.message)).toEqual(["This path is outside the workspace."]);
    expect(ipcCalls.filter((c) => c.method === "rename")).toHaveLength(0);
  });
});
