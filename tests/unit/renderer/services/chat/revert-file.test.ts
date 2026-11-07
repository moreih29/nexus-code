import { beforeEach, describe, expect, mock, test } from "bun:test";

const SRC = "../../../../../src/renderer";

// What the workspace has, by its path from the root.
let files: Map<string, string>;
const calls: string[] = [];
mock.module(`${SRC}/ipc/client`, () => ({
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    calls.push(`${method} ${args.relPath}`);
    const rel = String(args.relPath);
    if (method === "writeFile") {
      if (files.has(rel)) {
        return Promise.resolve({ ok: true, value: { kind: "conflict", actual: { exists: true } } });
      }
      files.set(rel, String(args.content));
      return Promise.resolve({ ok: true, value: { kind: "ok", mtime: "0", size: 1 } });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
  unwrapIpcResult: (result: { ok: boolean; value?: unknown; message?: string }) => {
    if (!result.ok) throw new Error(result.message);
    return result.value;
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));
mock.module(`${SRC}/components/ui/confirm-dialog`, () => ({
  showConfirmDialog: () => Promise.resolve(true),
}));
const toasts: { kind: string; message: string }[] = [];
mock.module(`${SRC}/components/ui/toast`, () => ({
  showToast: (toast: { kind: string; message: string }) => toasts.push(toast),
}));
mock.module(`${SRC}/services/editor/model`, () => ({
  // Every file asked for is gone, as the session deleted it: the load ends
  // in the error phase rather than throwing.
  acquireModel: () => Promise.resolve({ model: null, phase: "error", errorCode: "NOT_FOUND" }),
  releaseModel: () => {},
}));
mock.module(`${SRC}/services/editor/save/service`, () => ({
  saveModelInteractive: () => Promise.resolve({ kind: "saved" }),
  reportSaveFailure: () => {},
}));
mock.module(`${SRC}/services/fs-mutations/confirm-delete`, () => ({
  confirmAndDeletePath: () => Promise.resolve(true),
}));

const { revertChangedFile } = await import(`${SRC}/services/chat/revert-file`);

beforeEach(() => {
  files = new Map();
  calls.length = 0;
  toasts.length = 0;
});

describe("reverting a file the session deleted", () => {
  test("writes it again with its text, its folder first", async () => {
    const reverted = await revertChangedFile("ws", "C:/w", "C:/w/src/gone.txt", "bye\r\n", "codex");
    expect(reverted).toBe(true);
    expect(calls).toEqual(["mkdir src", "writeFile src/gone.txt"]);
    expect(files.get("src/gone.txt")).toBe("bye\r\n");
    expect(toasts.map((toast) => toast.kind)).toEqual(["info"]);
  });

  test("leaves a file that appeared meanwhile as it is", async () => {
    files.set("gone.txt", "someone else's");
    const reverted = await revertChangedFile("ws", "/w", "/w/gone.txt", "bye\n", "codex");
    expect(reverted).toBe(false);
    expect(calls).toEqual(["writeFile gone.txt"]);
    expect(files.get("gone.txt")).toBe("someone else's");
    expect(toasts.map((toast) => toast.kind)).toEqual(["error"]);
  });
});
