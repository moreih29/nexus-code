import { beforeEach, describe, expect, it, mock } from "bun:test";

type IpcCall = { channel: string; method: string; args: unknown };

const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const ROOT = "/repo";
const ipcCalls: IpcCall[] = [];
const confirm = mock(() => true);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    if (channel === "fs" && method === "readdir")
      return Promise.resolve({ ok: true as const, value: [] });
    return Promise.resolve({ ok: true as const, value: undefined });
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

const { useFileTreeActions } = await import(
  "../../../../../src/renderer/components/files/hooks/use-file-tree-actions"
);
const { useFilesStore } = await import("../../../../../src/renderer/state/stores/files");

function installWindow(): void {
  (globalThis as { window?: unknown }).window = {
    confirm,
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
    host: { platform: "darwin" },
  };
}

function resetTree(): void {
  useFilesStore.setState({ trees: new Map(), activeAbsPath: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "dir", type: "dir" },
    { name: "ln", type: "symlink" },
  ]);
}

describe("useFileTreeActions rename/delete routing", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    confirm.mockClear();
    installWindow();
    resetTree();
  });

  it("routes file delete through fs.unlink", async () => {
    const target = { absPath: `${ROOT}/a.ts`, type: "file" as const };
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTarget: () => target,
      startCreate: () => {},
      startRename: () => {},
    });

    await actions.delete();

    expect(ipcCalls[0]).toEqual({
      channel: "fs",
      method: "unlink",
      args: { workspaceId: WS, relPath: "a.ts" },
    });
  });

  it("routes directory delete through fs.rmdir", async () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTarget: () => ({ absPath: `${ROOT}/dir`, type: "dir" }),
      startCreate: () => {},
      startRename: () => {},
    });

    await actions.delete();

    expect(ipcCalls[0]).toEqual({
      channel: "fs",
      method: "rmdir",
      args: { workspaceId: WS, relPath: "dir" },
    });
  });

  it("starts inline rename for a non-root target", () => {
    const startRename = mock(() => {});
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTarget: () => ({ absPath: `${ROOT}/a.ts`, type: "file" }),
      startCreate: () => {},
      startRename,
    });

    actions.rename();

    expect(startRename).toHaveBeenCalledWith(`${ROOT}/a.ts`);
  });

  it("does not rename or delete the root target", async () => {
    const startRename = mock(() => {});
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTarget: () => ({ absPath: ROOT, type: "dir", isRoot: true }),
      startCreate: () => {},
      startRename,
    });

    actions.rename();
    await actions.delete();

    expect(startRename).not.toHaveBeenCalled();
    expect(ipcCalls).toEqual([]);
  });
});
