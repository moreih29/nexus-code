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
  // Unwrappers used across the (now wider) fs-mutations / clipboard import
  // graph pulled in via useFileTreeActions. Mirror the real helpers: return
  // the value on ok, throw on error.
  unwrapIpcResult: <T>(r: { ok: boolean; value?: T; error?: { message?: string } }): T => {
    if (!r.ok) throw new Error(r.error?.message ?? "ipc error");
    return r.value as T;
  },
  mustSucceed: <T>(r: { ok: boolean; value?: T; error?: { message?: string } }): T => {
    if (!r.ok) throw new Error(r.error?.message ?? "ipc error");
    return r.value as T;
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

// Delete/copy routing goes through the imperative confirm dialog. With no React
// tree mounted the real queue never resolves, so auto-confirm here — these
// tests assert the downstream fs IPC, not the dialog UX.
mock.module("../../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: () => Promise.resolve(true),
}));

const { useFileTreeActions } = await import(
  "../../../../../src/renderer/components/files/hooks/use-file-tree-actions"
);
const { useFilesStore } = await import("../../../../../src/renderer/state/stores/files");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");

type LocationKind = "local" | "ssh";

function seedWorkspace(kind: LocationKind): void {
  const location =
    kind === "local"
      ? { kind: "local" as const, rootPath: ROOT }
      : { kind: "ssh" as const, host: "dev.example.com", remotePath: ROOT };
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: WS,
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
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "b.ts", type: "file" },
    { name: "dir", type: "dir" },
    { name: "ln", type: "symlink" },
  ]);
}

// ---------------------------------------------------------------------------
// Single-target delete (N=1) — regression for existing behaviour
// ---------------------------------------------------------------------------

describe("useFileTreeActions — single-target delete routing", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    confirm.mockClear();
    installWindow();
    resetTree();
    seedWorkspace("local");
  });

  it("routes file delete to fs.trash on a local workspace", async () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: `${ROOT}/a.ts`, type: "file" as const }],
      startCreate: () => {},
      startRename: () => {},
    });

    await actions.delete();

    expect(ipcCalls[0]).toEqual({
      channel: "fs",
      method: "trash",
      args: { workspaceId: WS, relPath: "a.ts" },
    });
  });

  it("routes directory delete to fs.trash on a local workspace", async () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: `${ROOT}/dir`, type: "dir" as const }],
      startCreate: () => {},
      startRename: () => {},
    });

    await actions.delete();

    expect(ipcCalls[0]).toEqual({
      channel: "fs",
      method: "trash",
      args: { workspaceId: WS, relPath: "dir" },
    });
  });

  it("falls back to fs.unlink for files on SSH workspaces (no remote trash)", async () => {
    seedWorkspace("ssh");
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: `${ROOT}/a.ts`, type: "file" as const }],
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

  it("falls back to fs.removeAll for directories on SSH workspaces (no remote trash)", async () => {
    seedWorkspace("ssh");
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: `${ROOT}/dir`, type: "dir" as const }],
      startCreate: () => {},
      startRename: () => {},
    });

    await actions.delete();

    expect(ipcCalls[0]).toEqual({
      channel: "fs",
      method: "removeAll",
      args: { workspaceId: WS, relPath: "dir" },
    });
  });

  it("starts inline rename for a non-root target", () => {
    const startRename = mock(() => {});
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: `${ROOT}/a.ts`, type: "file" as const }],
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
      getTargets: () => [{ absPath: ROOT, type: "dir" as const, isRoot: true }],
      startCreate: () => {},
      startRename,
    });

    actions.rename();
    await actions.delete();

    expect(startRename).not.toHaveBeenCalled();
    expect(ipcCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multi-target delete (N≥2) — Phase C batch behaviour
// ---------------------------------------------------------------------------

describe("useFileTreeActions — multi-target delete (batch)", () => {
  beforeEach(() => {
    ipcCalls.length = 0;
    confirm.mockClear();
    installWindow();
    resetTree();
    seedWorkspace("local");
  });

  it("deletes two files via fs.trash on local workspace", async () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [
        { absPath: `${ROOT}/a.ts`, type: "file" as const },
        { absPath: `${ROOT}/b.ts`, type: "file" as const },
      ],
      startCreate: () => {},
      startRename: () => {},
    });

    await actions.delete();

    const trashCalls = ipcCalls.filter((c) => c.method === "trash");
    expect(trashCalls).toHaveLength(2);
    const relPaths = trashCalls.map((c) => (c.args as { relPath: string }).relPath);
    expect(relPaths).toContain("a.ts");
    expect(relPaths).toContain("b.ts");
  });

  it("multi-target rename shows toast and does not call startRename", () => {
    const startRename = mock(() => {});
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [
        { absPath: `${ROOT}/a.ts`, type: "file" as const },
        { absPath: `${ROOT}/b.ts`, type: "file" as const },
      ],
      startCreate: () => {},
      startRename,
    });

    actions.rename();

    expect(startRename).not.toHaveBeenCalled();
  });

  it("distinctParents applied: parent+child → only parent deleted", async () => {
    // Seed: dir has child a.ts
    useFilesStore.getState().setChildren(WS, `${ROOT}/dir`, [{ name: "a.ts", type: "file" }]);

    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      // Both dir and its child — distinctParents should reduce to just dir.
      getTargets: () => [
        { absPath: `${ROOT}/dir`, type: "dir" as const },
        { absPath: `${ROOT}/dir/a.ts`, type: "file" as const },
      ],
      startCreate: () => {},
      startRename: () => {},
    });

    await actions.delete();

    const trashCalls = ipcCalls.filter((c) => c.method === "trash");
    // Only the parent dir should be trashed, not the child.
    expect(trashCalls).toHaveLength(1);
    expect((trashCalls[0].args as { relPath: string }).relPath).toBe("dir");
  });

  it("root target filtered out of multi-delete, only non-root paths deleted", async () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [
        { absPath: ROOT, type: "dir" as const, isRoot: true },
        { absPath: `${ROOT}/a.ts`, type: "file" as const },
      ],
      startCreate: () => {},
      startRename: () => {},
    });

    await actions.delete();

    const trashCalls = ipcCalls.filter((c) => c.method === "trash");
    expect(trashCalls).toHaveLength(1);
    expect((trashCalls[0].args as { relPath: string }).relPath).toBe("a.ts");
  });
});
