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

const { createNewFile, renamePath, unlinkPath } = await import(
  "../../../../src/renderer/services/fs-mutations"
);
const { registerTabFocusTarget } = await import("../../../../src/renderer/services/tab-focus");
const { useFilesStore } = await import("../../../../src/renderer/state/stores/files");
const { useTabsStore } = await import("../../../../src/renderer/state/stores/tabs");

function resetTree(): void {
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
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

  it("exports unlink/rename methods that call the fs IPC contract", async () => {
    await unlinkPath({ workspaceId: WS, workspaceRootPath: ROOT, absPath: `${ROOT}/a.ts` });
    await renamePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      absPath: `${ROOT}/a.ts`,
      newName: "b.ts",
    });

    expect(ipcCalls.filter((call) => call.method !== "readdir")).toEqual([
      { channel: "fs", method: "unlink", args: { workspaceId: WS, relPath: "a.ts" } },
      {
        channel: "fs",
        method: "rename",
        args: { workspaceId: WS, fromRelPath: "a.ts", toRelPath: "b.ts" },
      },
    ]);
  });

  it("focuses the editor of a newly created file", async () => {
    const frames: FrameRequestCallback[] = [];
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      frames.push(callback)) as typeof requestAnimationFrame;
    try {
      const ok = await createNewFile({
        workspaceId: WS,
        workspaceRootPath: ROOT,
        parentAbsPath: ROOT,
        name: "new.ts",
      });
      expect(ok).toBe(true);

      const tab = Object.values(useTabsStore.getState().byWorkspace[WS] ?? {}).find(
        (candidate) => candidate.type === "editor" && candidate.props.filePath === `${ROOT}/new.ts`,
      );
      if (!tab) throw new Error("editor tab not opened");
      let focused = false;
      registerTabFocusTarget(tab.id, () => {
        focused = true;
      });
      for (const frame of frames.splice(0)) frame(0);
      expect(focused).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });

  it("points an open tab at the renamed file", async () => {
    const tab = useTabsStore.getState().createTab(WS, {
      type: "editor",
      props: { workspaceId: WS, filePath: `${ROOT}/a.ts` },
    });

    await renamePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      absPath: `${ROOT}/a.ts`,
      newName: "b.ts",
    });

    const renamed = useTabsStore.getState().byWorkspace[WS]?.[tab.id];
    expect(renamed?.type === "editor" && renamed.props.filePath).toBe(`${ROOT}/b.ts`);
    expect(renamed?.title).toBe("b.ts");
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
