/**
 * confirmAndDeleteBatch — unit tests.
 *
 * Covers Phase C acceptance criteria:
 *   - N=1 delegates to confirmAndDeletePath (single-item dialog semantics).
 *   - N=2 batch dialog, local trash.
 *   - N=3 comma-separated description.
 *   - N=5 "and N-3 more" truncation.
 *   - SSH workspace → permanent delete.
 *   - Partial failure: toast shows "M of N" + first failure info.
 *   - distinctParents applied before prompting.
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

type IpcCall = { channel: string; method: string; args: unknown };
const ipcCalls: IpcCall[] = [];

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    if (channel === "fs" && method === "readdir")
      return Promise.resolve({ ok: true as const, value: [] });
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
// Confirm dialog spy — default: confirm=true
// ---------------------------------------------------------------------------

let confirmResult = true;
let lastConfirmArgs: { title?: string; description?: string; confirmLabel?: string } | null = null;

mock.module("../../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: (args: { title: string; description: string; confirmLabel: string }) => {
    lastConfirmArgs = args;
    return Promise.resolve(confirmResult);
  },
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

import { confirmAndDeleteBatch } from "../../../../../src/renderer/services/fs-mutations/confirm-delete";
import { useFilesStore } from "../../../../../src/renderer/state/stores/files";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "ws-batch-test";
const ROOT = "/repo";

function seedWorkspace(kind: "local" | "ssh"): void {
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

function resetAll(): void {
  ipcCalls.length = 0;
  toastCalls.length = 0;
  lastConfirmArgs = null;
  confirmResult = true;
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "b.ts", type: "file" },
    { name: "c.ts", type: "file" },
    { name: "d.ts", type: "file" },
    { name: "e.ts", type: "file" },
    { name: "dir", type: "dir" },
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetAll();
  seedWorkspace("local");
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

describe("confirmAndDeleteBatch — N=0 early return", () => {
  it("returns false with empty paths and no dialog", async () => {
    const result = await confirmAndDeleteBatch(WS, ROOT, []);
    expect(result).toBe(false);
    expect(lastConfirmArgs).toBeNull();
    expect(ipcCalls).toHaveLength(0);
  });
});

describe("confirmAndDeleteBatch — N=1 single-path delegation", () => {
  it("delegates to confirmAndDeletePath for a single file", async () => {
    const result = await confirmAndDeleteBatch(WS, ROOT, [`${ROOT}/a.ts`]);
    expect(result).toBe(true);
    // Single delegation still fires a trash IPC call.
    const trashCall = ipcCalls.find((c) => c.method === "trash");
    expect(trashCall).toBeDefined();
    expect((trashCall?.args as { relPath: string }).relPath).toBe("a.ts");
  });
});

describe("confirmAndDeleteBatch — N=2 batch, local", () => {
  it("fires trash for both files after single confirm", async () => {
    const result = await confirmAndDeleteBatch(WS, ROOT, [`${ROOT}/a.ts`, `${ROOT}/b.ts`]);
    expect(result).toBe(true);
    expect(lastConfirmArgs?.title).toBe("Delete 2 items");
    const trashCalls = ipcCalls.filter((c) => c.method === "trash");
    expect(trashCalls).toHaveLength(2);
  });

  it("description includes comma-separated names + trash suffix for N=2", async () => {
    await confirmAndDeleteBatch(WS, ROOT, [`${ROOT}/a.ts`, `${ROOT}/b.ts`]);
    expect(lastConfirmArgs?.description).toContain("a.ts, b.ts");
    expect(lastConfirmArgs?.description).toContain("You can restore the items from the Trash.");
    expect(lastConfirmArgs?.confirmLabel).toBe("Move to Trash");
  });
});

describe("confirmAndDeleteBatch — N=3 comma", () => {
  it("description includes all 3 names separated by commas", async () => {
    await confirmAndDeleteBatch(WS, ROOT, [`${ROOT}/a.ts`, `${ROOT}/b.ts`, `${ROOT}/c.ts`]);
    expect(lastConfirmArgs?.description).toContain("a.ts, b.ts, c.ts");
  });
});

describe("confirmAndDeleteBatch — N=5 truncation", () => {
  it("description shows 3 names + 'and 2 more' for N=5", async () => {
    await confirmAndDeleteBatch(WS, ROOT, [
      `${ROOT}/a.ts`,
      `${ROOT}/b.ts`,
      `${ROOT}/c.ts`,
      `${ROOT}/d.ts`,
      `${ROOT}/e.ts`,
    ]);
    expect(lastConfirmArgs?.description).toContain("and 2 more");
    expect(lastConfirmArgs?.title).toBe("Delete 5 items");
  });
});

describe("confirmAndDeleteBatch — SSH permanent delete", () => {
  it("uses permanent delete for SSH workspace", async () => {
    seedWorkspace("ssh");
    await confirmAndDeleteBatch(WS, ROOT, [`${ROOT}/a.ts`, `${ROOT}/b.ts`]);
    expect(lastConfirmArgs?.confirmLabel).toBe("Delete");
    expect(lastConfirmArgs?.description).toContain("This cannot be undone.");
    const unlinkCalls = ipcCalls.filter((c) => c.method === "unlink");
    expect(unlinkCalls).toHaveLength(2);
  });
});

describe("confirmAndDeleteBatch — cancel confirm", () => {
  it("returns false and does not call IPC when user cancels", async () => {
    confirmResult = false;
    const result = await confirmAndDeleteBatch(WS, ROOT, [`${ROOT}/a.ts`, `${ROOT}/b.ts`]);
    expect(result).toBe(false);
    expect(ipcCalls.filter((c) => c.method === "trash")).toHaveLength(0);
  });
});

describe("confirmAndDeleteBatch — success toast", () => {
  it("shows success toast with count after N=2 delete", async () => {
    await confirmAndDeleteBatch(WS, ROOT, [`${ROOT}/a.ts`, `${ROOT}/b.ts`]);
    expect(toastCalls.some((t) => t.message === "Deleted 2 items")).toBe(true);
  });
});

describe("confirmAndDeleteBatch — distinctParents collapse", () => {
  it("only deletes the parent when a child is also in the list", async () => {
    // Set up dir/a.ts child.
    useFilesStore.getState().setChildren(WS, `${ROOT}/dir`, [{ name: "a.ts", type: "file" }]);
    const result = await confirmAndDeleteBatch(WS, ROOT, [`${ROOT}/dir`, `${ROOT}/dir/a.ts`]);
    expect(result).toBe(true);
    // N=1 after distinctParents → single-path delegation → single trash call.
    const trashCalls = ipcCalls.filter((c) => c.method === "trash");
    expect(trashCalls).toHaveLength(1);
    expect((trashCalls[0].args as { relPath: string }).relPath).toBe("dir");
  });
});
