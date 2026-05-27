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

type IpcCall = { channel: string; method: string; args: unknown };
const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const ROOT = "/repo";
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

const { movePath, renamePath } = await import(
  "../../../../../src/renderer/services/fs-mutations"
);
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
  useFilesStore.setState({ trees: new Map(), activeAbsPath: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "dir", type: "dir" },
    { name: "other", type: "dir" },
  ]);
  useFilesStore.getState().setChildren(WS, `${ROOT}/dir`, [
    { name: "nested.ts", type: "file" },
  ]);
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
      },
    });

    // Should refresh both source parent and dest parent via readdir
    const readdirCalls = ipcCalls.filter((c) => c.method === "readdir");
    expect(readdirCalls).toHaveLength(2);
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

  // ---- ALREADY_EXISTS toast ----

  it("returns false with already-exists toast when target name collides", async () => {
    rejectNext = new Error("ALREADY_EXISTS: /repo/other/nested.ts");

    const ok = await movePath({
      workspaceId: WS,
      workspaceRootPath: ROOT,
      srcAbsPath: `${ROOT}/dir/nested.ts`,
      dstDirAbsPath: `${ROOT}/other`,
    });

    expect(ok).toBe(false);
    expect(toastCalls.map((c) => c.message)).toEqual([
      "A file or folder with that name already exists at the destination.",
    ]);
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
    expect(toastCalls.map((c) => c.message)).toEqual([
      "This path is outside the workspace.",
    ]);
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
    expect(toastCalls.map((c) => c.message)).toEqual([
      "This path is outside the workspace.",
    ]);
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