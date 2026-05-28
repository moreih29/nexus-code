import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — mirrors fs-mutations.test.ts patterns
// ---------------------------------------------------------------------------

const toastCalls: Array<{ kind: string; message: string }> = [];

mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: { kind: string; message: string }) => {
    toastCalls.push(input);
  },
}));

// movePath now asks the user before overwriting (VSCode parity); the test
// drives that decision via `confirmReply` per case.
let confirmReply: boolean = true;
mock.module("../../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: () => Promise.resolve(confirmReply),
}));

type IpcCall = { channel: string; method: string; args: unknown };
const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const ROOT = "/repo";
const ipcCalls: IpcCall[] = [];
let rejectNext: Error | null = null;
// Per-test readdir result so the pre-check can simulate "destination has a
// name collision" without affecting later refresh readdirs.
let readdirEntries: Array<{ name: string; type: "file" | "dir" | "symlink" }> = [];

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    // readdir always succeeds — the pre-check is supposed to be silent on its
    // own behalf. rejectNext applies only to subsequent writes.
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

// ---------------------------------------------------------------------------
// Imports (after mocks are installed)
// ---------------------------------------------------------------------------

const { movePath, renamePath } = await import("../../../../../src/renderer/services/fs-mutations");
const { useFilesStore } = await import("../../../../../src/renderer/state/stores/files");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("movePath", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    toastCalls.length = 0;
    rejectNext = null;
    readdirEntries = [];
    confirmReply = true;
    installWindow();
    resetTree();
  });

  // ---- Core IPC shape ----

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

    // readdir is now called 3x: the destination pre-check + the two refresh
    // calls (source parent + dest parent) after the move.
    const readdirCalls = ipcCalls.filter((c) => c.method === "readdir");
    expect(readdirCalls).toHaveLength(3);
  });

  // ---- Same-dir no-op ----

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

  // ---- NOT_FOUND toast ----

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

  // ---- Replace-on-collision (VSCode parity) ----

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
    // No error toast was raised — the collision was handled by the prompt.
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

  // ---- Out-of-workspace guard (source) ----

  it("returns false with out-of-workspace toast when srcAbsPath is outside workspace", async () => {
    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: "/outside/file.txt",
      dstDirAbsPath: `${ROOT}/other`,
    });

    expect(ok).toBe(false);
    expect(toastCalls.map((c) => c.message)).toEqual(["This path is outside the workspace."]);
    // No IPC should have been made
    expect(ipcCalls.filter((c) => c.method === "rename")).toHaveLength(0);
  });

  // ---- Out-of-workspace guard (destination) ----

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

  // ---- Regression: renamePath unchanged ----

  it("renamePath still works correctly (regression guard)", async () => {
    const ok = await renamePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      absPath: `${ROOT}/a.ts`,
      newName: "b.ts",
    });

    expect(ok).toBe(true);

    const renameCalls = ipcCalls.filter((c) => c.method === "rename");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]).toEqual({
      channel: "fs",
      method: "rename",
      args: {
        workspaceId: WS,
        fromRelPath: "a.ts",
        toRelPath: "b.ts",
      },
    });

    // renamePath refreshes only the parent (ROOT), not both
    const readdirCalls = ipcCalls.filter((c) => c.method === "readdir");
    expect(readdirCalls).toHaveLength(1);
  });

  // ---- Same-dir but target path computed by movePath matches source (different parent path variant) ----

  it("returns true without IPC when dstDirAbsPath equals the source's actual parent", async () => {
    // srcAbsPath = /repo/a.ts, its parent is /repo. dstDirAbsPath = /repo
    // toRelPath = repo/a.ts (or `a.ts` after relPath normalization)
    // fromRel = a.ts, toRel = a.ts → same, no-op
    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/a.ts`,
      dstDirAbsPath: ROOT,
    });

    expect(ok).toBe(true);
    expect(ipcCalls).toHaveLength(0);
  });
});
