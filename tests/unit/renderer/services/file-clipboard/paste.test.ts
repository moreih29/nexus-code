/**
 * handlePaste — unit tests.
 *
 * Drives the real paste service against the real clipboard, active and files
 * stores, with an IPC spy standing in for the fs channel.
 *
 * Covers:
 *  - Target resolution: explicit dir → itself, file → its parent, no target →
 *    the tree focus, falling back to the root.
 *  - Cut: one rename per entry, clipboard cleared once something moved.
 *  - Copy: one copyFile per entry; pasting a folder onto itself makes a
 *    sibling copy instead of nesting it.
 *  - Summary toast only for N≥2; partial failure names the first failed item.
 *  - Cycle guard (cut), distinctParents, cross-workspace guard.
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

type IpcCall = { channel: string; method: string; args: Record<string, unknown> };
const ipcCalls: IpcCall[] = [];
/** fromRelPath whose rename / copyFile fails with PERMISSION_DENIED. */
let failFromRelPaths = new Set<string>();
/** Names readdir reports per workspace-relative directory. */
let dirNames: Record<string, string[]> = {};

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: Record<string, unknown>) => {
    ipcCalls.push({ channel, method, args });
    if (
      (method === "rename" || method === "copyFile") &&
      failFromRelPaths.has(args.fromRelPath as string)
    )
      return Promise.resolve({
        ok: false as const,
        error: { message: `PERMISSION_DENIED: /repo/${args.fromRelPath}` },
      });
    if (method === "readdir") {
      const names = dirNames[args.relPath as string] ?? [];
      return Promise.resolve({
        ok: true as const,
        value: names.map((name) => ({ name, type: "file" })),
      });
    }
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

import { handlePaste } from "../../../../../src/renderer/services/file-clipboard/paste";
import {
  type ClipboardEntry,
  useFileClipboardStore,
} from "../../../../../src/renderer/services/file-clipboard/store";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useFilesStore } from "../../../../../src/renderer/state/stores/files";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "ws-paste-test";
const ROOT = "/repo";

function entry(relPath: string): ClipboardEntry {
  return { relPath, absPath: `${ROOT}/${relPath}` };
}

function setClipboard(kind: "cut" | "copy", relPaths: string[]): void {
  useFileClipboardStore.getState().set(kind, WS, relPaths.map(entry), ROOT);
}

function calls(method: string): Record<string, unknown>[] {
  return ipcCalls.filter((c) => c.method === method).map((c) => c.args);
}

beforeEach(() => {
  ipcCalls.length = 0;
  toastCalls.length = 0;
  failFromRelPaths = new Set();
  dirNames = {};
  useActiveStore.setState({ activeWorkspaceId: WS });
  useFileClipboardStore.getState().clear();
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "src", type: "dir" },
    { name: "lib", type: "dir" },
    { name: "a.ts", type: "file" },
    { name: "b.ts", type: "file" },
  ]);
});

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

describe("handlePaste — target", () => {
  it("pastes into an explicit directory target", async () => {
    setClipboard("copy", ["a.ts"]);
    await handlePaste(`${ROOT}/src`);
    expect(calls("copyFile").map((a) => a.toRelPath)).toEqual(["src/a.ts"]);
  });

  it("pastes next to an explicit file target", async () => {
    setClipboard("copy", ["src/x.ts"]);
    await handlePaste(`${ROOT}/b.ts`);
    expect(calls("copyFile").map((a) => a.toRelPath)).toEqual(["x.ts"]);
  });

  it("uses the tree focus when no target is given", async () => {
    useFilesStore.getState().setFocus(WS, `${ROOT}/lib`);
    setClipboard("copy", ["a.ts"]);
    await handlePaste();
    expect(calls("copyFile").map((a) => a.toRelPath)).toEqual(["lib/a.ts"]);
  });

  it("falls back to the root without a target or focus", async () => {
    setClipboard("copy", ["src/x.ts"]);
    await handlePaste();
    expect(calls("copyFile").map((a) => a.toRelPath)).toEqual(["x.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Cut
// ---------------------------------------------------------------------------

describe("handlePaste — cut", () => {
  it("moves every entry, clears the clipboard and summarizes", async () => {
    setClipboard("cut", ["a.ts", "b.ts"]);
    await handlePaste(`${ROOT}/src`);
    expect(calls("rename").map((a) => [a.fromRelPath, a.toRelPath])).toEqual([
      ["a.ts", "src/a.ts"],
      ["b.ts", "src/b.ts"],
    ]);
    expect(useFileClipboardStore.getState().kind).toBeNull();
    expect(toastCalls).toEqual([{ kind: "info", message: "Pasted 2 items" }]);
  });

  it("moves a single entry without a summary toast", async () => {
    setClipboard("cut", ["a.ts"]);
    await handlePaste(`${ROOT}/src`);
    expect(calls("rename")).toHaveLength(1);
    expect(toastCalls).toEqual([]);
  });

  it("skips a folder cut into itself and names it in the summary", async () => {
    setClipboard("cut", ["src", "a.ts"]);
    await handlePaste(`${ROOT}/src`);
    expect(calls("rename").map((a) => a.fromRelPath)).toEqual(["a.ts"]);
    expect(toastCalls).toEqual([
      { kind: "error", message: `Can't move "src" into itself or one of its subfolders.` },
      { kind: "error", message: `Pasted 1 of 2 items. Couldn't paste "src".` },
    ]);
  });

  it("pastes only the parent when a child is also on the clipboard", async () => {
    setClipboard("cut", ["src", "src/index.ts"]);
    await handlePaste(`${ROOT}/lib`);
    expect(calls("rename").map((a) => a.toRelPath)).toEqual(["lib/src"]);
    expect(toastCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe("handlePaste — copy", () => {
  it("copies every entry, keeps the clipboard and summarizes", async () => {
    setClipboard("copy", ["a.ts", "b.ts"]);
    await handlePaste(`${ROOT}/src`);
    expect(calls("copyFile").map((a) => [a.fromRelPath, a.toRelPath])).toEqual([
      ["a.ts", "src/a.ts"],
      ["b.ts", "src/b.ts"],
    ]);
    expect(useFileClipboardStore.getState().kind).toBe("copy");
    expect(toastCalls).toEqual([{ kind: "info", message: "Pasted 2 items" }]);
  });

  it("copies a folder pasted onto itself next to it", async () => {
    dirNames[""] = ["src", "lib", "a.ts", "b.ts"];
    setClipboard("copy", ["src"]);
    await handlePaste(`${ROOT}/src`);
    expect(calls("copyFile").map((a) => a.toRelPath)).toEqual(["src copy"]);
  });
});

// ---------------------------------------------------------------------------
// Partial failure
// ---------------------------------------------------------------------------

describe("handlePaste — partial failure", () => {
  it("names the first failed item and still clears a cut that moved something", async () => {
    failFromRelPaths = new Set(["a.ts"]);
    setClipboard("cut", ["a.ts", "b.ts"]);
    await handlePaste(`${ROOT}/src`);
    expect(toastCalls).toEqual([
      { kind: "error", message: "Permission denied while moving item." },
      { kind: "error", message: `Pasted 1 of 2 items. Couldn't paste "a.ts".` },
    ]);
    expect(useFileClipboardStore.getState().kind).toBeNull();
  });

  it("keeps the clipboard when nothing moved", async () => {
    failFromRelPaths = new Set(["a.ts", "b.ts"]);
    setClipboard("cut", ["a.ts", "b.ts"]);
    await handlePaste(`${ROOT}/src`);
    expect(toastCalls.at(-1)).toEqual({
      kind: "error",
      message: `Pasted 0 of 2 items. Couldn't paste "a.ts".`,
    });
    expect(useFileClipboardStore.getState().kind).toBe("cut");
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("handlePaste — guards", () => {
  it("does nothing with an empty clipboard", async () => {
    await handlePaste(`${ROOT}/src`);
    expect(ipcCalls).toEqual([]);
  });

  it("clears a clipboard from another workspace without pasting", async () => {
    useFileClipboardStore.getState().set("copy", "ws-other", [entry("a.ts")], ROOT);
    await handlePaste(`${ROOT}/src`);
    expect(ipcCalls).toEqual([]);
    expect(useFileClipboardStore.getState().kind).toBeNull();
  });
});
