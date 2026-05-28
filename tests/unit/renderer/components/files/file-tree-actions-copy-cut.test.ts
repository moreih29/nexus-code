/**
 * Phase D — useFileTreeActions copy/cut multi-selection tests.
 *
 * Covers:
 *  - copy/cut with N=1 → handleCopy/handleCut called with 1 entry, no toast.
 *  - copy/cut with N=2 → handleCopy/handleCut called with 2 entries + info toast.
 *  - distinctParents: parent+child → only parent in entries.
 *  - isRoot targets filtered out of copy/cut.
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

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: () => Promise.resolve({ ok: true as const, value: [] }),
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

mock.module("../../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: () => Promise.resolve(true),
}));

// ---------------------------------------------------------------------------
// Clipboard spies
// ---------------------------------------------------------------------------

type CopyInput = {
  workspaceId: string;
  workspaceRootPath: string;
  entries: { relPath: string; absPath: string }[];
};

const copyCalls: CopyInput[] = [];
const cutCalls: CopyInput[] = [];
const toastCalls: { kind: string; message: string }[] = [];

mock.module("../../../../../src/renderer/services/file-clipboard", () => ({
  handleCopy: (input: CopyInput) => {
    copyCalls.push(input);
  },
  handleCut: (input: CopyInput) => {
    cutCalls.push(input);
  },
  handlePaste: () => Promise.resolve(),
  useFileClipboardStore: { getState: () => ({ kind: null, entries: [] }) },
}));

mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: { kind: string; message: string }) => {
    toastCalls.push(input);
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { useFileTreeActions } from "../../../../../src/renderer/components/files/hooks/use-file-tree-actions";
import { useFilesStore } from "../../../../../src/renderer/state/stores/files";

const WS = "ws-copy-cut-test";
const ROOT = "/repo";

function resetStore(): void {
  copyCalls.length = 0;
  cutCalls.length = 0;
  toastCalls.length = 0;
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
  useFilesStore.getState().initTree(WS, ROOT, []);
  useFilesStore.getState().setChildren(WS, ROOT, [
    { name: "a.ts", type: "file" },
    { name: "b.ts", type: "file" },
    { name: "src", type: "dir" },
  ]);
  useFilesStore.getState().setChildren(WS, `${ROOT}/src`, [{ name: "index.ts", type: "file" }]);
}

beforeEach(resetStore);

// ---------------------------------------------------------------------------
// Single copy — no toast
// ---------------------------------------------------------------------------

describe("useFileTreeActions.copy — single target, no toast", () => {
  it("calls handleCopy with 1 entry and no toast for N=1", () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: `${ROOT}/a.ts`, type: "file" as const }],
      startCreate: () => {},
      startRename: () => {},
    });

    actions.copy();

    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0].entries).toHaveLength(1);
    expect(copyCalls[0].entries[0].absPath).toBe(`${ROOT}/a.ts`);
    expect(toastCalls.filter((t) => t.kind === "info")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi copy — toast
// ---------------------------------------------------------------------------

describe("useFileTreeActions.copy — multi-target, info toast for N≥2", () => {
  it("calls handleCopy with 2 entries and shows info toast", () => {
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

    actions.copy();

    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0].entries).toHaveLength(2);
    const infoToast = toastCalls.find((t) => t.kind === "info" && t.message === "Copied 2 items");
    expect(infoToast).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Single cut — no toast
// ---------------------------------------------------------------------------

describe("useFileTreeActions.cut — single target, no toast", () => {
  it("calls handleCut with 1 entry and no toast for N=1", () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: `${ROOT}/b.ts`, type: "file" as const }],
      startCreate: () => {},
      startRename: () => {},
    });

    actions.cut();

    expect(cutCalls).toHaveLength(1);
    expect(cutCalls[0].entries).toHaveLength(1);
    expect(toastCalls.filter((t) => t.kind === "info")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi cut — toast
// ---------------------------------------------------------------------------

describe("useFileTreeActions.cut — multi-target, info toast for N≥2", () => {
  it("calls handleCut with 2 entries and shows info toast", () => {
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

    actions.cut();

    expect(cutCalls).toHaveLength(1);
    expect(cutCalls[0].entries).toHaveLength(2);
    const infoToast = toastCalls.find((t) => t.kind === "info" && t.message === "Cut 2 items");
    expect(infoToast).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// distinctParents: parent+child → only parent in entries
// ---------------------------------------------------------------------------

describe("useFileTreeActions.copy — distinctParents collapses parent+child", () => {
  it("entries contain only the parent when child is also a target", () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [
        { absPath: `${ROOT}/src`, type: "dir" as const },
        { absPath: `${ROOT}/src/index.ts`, type: "file" as const },
      ],
      startCreate: () => {},
      startRename: () => {},
    });

    actions.copy();

    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0].entries).toHaveLength(1);
    expect(copyCalls[0].entries[0].absPath).toBe(`${ROOT}/src`);
  });
});

// ---------------------------------------------------------------------------
// isRoot targets filtered out
// ---------------------------------------------------------------------------

describe("useFileTreeActions.copy — root target filtered", () => {
  it("no-op when only target is isRoot=true", () => {
    const actions = useFileTreeActions({
      workspaceId: WS,
      rootAbsPath: ROOT,
      getTargets: () => [{ absPath: ROOT, type: "dir" as const, isRoot: true }],
      startCreate: () => {},
      startRename: () => {},
    });

    actions.copy();

    expect(copyCalls).toHaveLength(0);
  });

  it("filters root from mixed root+file targets", () => {
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

    actions.copy();

    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0].entries).toHaveLength(1);
    expect(copyCalls[0].entries[0].absPath).toBe(`${ROOT}/a.ts`);
  });
});
