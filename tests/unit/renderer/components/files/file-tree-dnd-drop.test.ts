/**
 * Phase E — DnD drop handler logic tests.
 *
 * Tests the drop-handling logic inline (not loading the full hook) to avoid
 * Bun mock.module contamination issues. Mirrors the pattern from paste-multi.test.ts.
 *
 * Covers:
 *  - Single path move: movePath called once, no summary toast.
 *  - Multi-path move: movePath called N times, info toast "Moved N items".
 *  - Copy: copyPathWithAutoRename called N times, info toast "Copied N items".
 *  - Self-drop guard (every): all paths in same dir → no-op.
 *  - Self-drop partial: some paths in same dir, some not → processes different ones.
 *  - Cycle guard: folder dropped into itself → warning toast, no ops.
 *  - Partial failure: error toast with "Moved M of N".
 *  - loadChildren called once after all ops.
 */

import { describe, expect, it } from "bun:test";
import { distinctParents } from "../../../../../src/renderer/services/fs-mutations/distinct-parents";

// ---------------------------------------------------------------------------
// Inline drop logic (mirrors use-file-tree-drop-target.ts handleDrop)
// ---------------------------------------------------------------------------

const ROOT = "/repo";

function parentOf(absPath: string, rootPath: string): string {
  const lastSlash = absPath.lastIndexOf("/");
  if (lastSlash <= 0) return rootPath;
  const parent = absPath.slice(0, lastSlash);
  if (!parent.startsWith(rootPath)) return rootPath;
  return parent;
}

function basename(absPath: string): string {
  return absPath.split("/").filter(Boolean).pop() ?? absPath;
}

function relPath(absPath: string, rootPath: string): string {
  const root = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  if (absPath === rootPath) return "";
  if (absPath.startsWith(root)) return absPath.slice(root.length);
  return absPath;
}

interface DropResult {
  moveCalls: { srcAbsPath: string; dstDirAbsPath: string }[];
  copyCalls: { fromRelPath: string; toRelPath: string }[];
  toasts: { kind: string; message: string }[];
  loadChildrenCalls: string[];
}

async function executeDrop(
  filePaths: string[],
  dir: string,
  copy: boolean,
  moveResults: Map<string, boolean> = new Map(),
  copyResults: Map<string, boolean> = new Map(),
): Promise<DropResult | null> {
  const moveCalls: { srcAbsPath: string; dstDirAbsPath: string }[] = [];
  const copyCalls: { fromRelPath: string; toRelPath: string }[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const loadChildrenCalls: string[] = [];

  // Self-drop guard: all paths already in target dir, move only.
  if (!copy && filePaths.every((p) => parentOf(p, ROOT) === dir)) {
    return null; // no-op
  }

  // Cycle guard.
  const hasCycle = filePaths.some((p) => dir === p || dir.startsWith(`${p}/`));
  if (hasCycle) {
    toasts.push({
      kind: "warning",
      message: "Cannot drop a folder into itself or one of its subfolders.",
    });
    return { moveCalls, copyCalls, toasts, loadChildrenCalls };
  }

  let successCount = 0;
  let firstFailurePath: string | null = null;
  let firstFailureMessage: string | null = null;

  for (const srcAbsPath of filePaths) {
    if (!copy && parentOf(srcAbsPath, ROOT) === dir) continue;

    let ok = false;
    if (copy) {
      const name = basename(srcAbsPath);
      const fromRel = relPath(srcAbsPath, ROOT);
      const toRel = relPath(`${dir}/${name}`, ROOT);
      copyCalls.push({ fromRelPath: fromRel, toRelPath: toRel });
      ok = copyResults.get(srcAbsPath) ?? true;
    } else {
      moveCalls.push({ srcAbsPath, dstDirAbsPath: dir });
      ok = moveResults.get(srcAbsPath) ?? true;
    }

    if (ok) {
      successCount += 1;
    } else if (firstFailurePath === null) {
      firstFailurePath = srcAbsPath;
      firstFailureMessage = copy ? "copy failed" : "move failed";
    }
  }

  if (successCount > 0) {
    loadChildrenCalls.push(dir);
  }

  const total = filePaths.length;
  const failCount = total - successCount;
  if (total >= 2) {
    const verb = copy ? "Copied" : "Moved";
    if (failCount === 0) {
      toasts.push({ kind: "info", message: `${verb} ${total} items` });
    } else {
      toasts.push({
        kind: "error",
        message: `${verb} ${successCount} of ${total}. First failure: ${firstFailurePath}: ${firstFailureMessage}`,
      });
    }
  }

  return { moveCalls, copyCalls, toasts, loadChildrenCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DnD drop — single path move, no toast", () => {
  it("moves one file, no summary toast", async () => {
    const result = await executeDrop([`${ROOT}/a.ts`], `${ROOT}/src`, false);
    expect(result).not.toBeNull();
    expect(result!.moveCalls).toHaveLength(1);
    expect(result!.moveCalls[0].srcAbsPath).toBe(`${ROOT}/a.ts`);
    expect(result!.toasts.filter((t) => t.kind === "info")).toHaveLength(0);
    expect(result!.loadChildrenCalls).toHaveLength(1);
  });
});

describe("DnD drop — multi-path move, info toast", () => {
  it("moves N files, shows Moved N items toast", async () => {
    const result = await executeDrop([`${ROOT}/a.ts`, `${ROOT}/b.ts`], `${ROOT}/src`, false);
    expect(result!.moveCalls).toHaveLength(2);
    expect(result!.toasts.some((t) => t.kind === "info" && t.message === "Moved 2 items")).toBe(
      true,
    );
    // loadChildren called once.
    expect(result!.loadChildrenCalls).toHaveLength(1);
  });
});

describe("DnD drop — multi-path copy, info toast", () => {
  it("copies N files, shows Copied N items toast", async () => {
    const result = await executeDrop([`${ROOT}/a.ts`, `${ROOT}/b.ts`], `${ROOT}/src`, true);
    expect(result!.copyCalls).toHaveLength(2);
    expect(result!.toasts.some((t) => t.kind === "info" && t.message === "Copied 2 items")).toBe(
      true,
    );
  });
});

describe("DnD drop — self-drop guard (every)", () => {
  it("no-op when all paths are already in the target dir", async () => {
    // src/a.ts and src/b.ts are both in /repo/src → self-drop.
    const result = await executeDrop(
      [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`],
      `${ROOT}/src`,
      false,
    );
    expect(result).toBeNull(); // no-op
  });

  it("proceeds when only some paths are in the same dir", async () => {
    // a.ts is in root, src/b.ts is in src; dropping onto src → a.ts moves, src/b.ts skipped.
    const result = await executeDrop([`${ROOT}/a.ts`, `${ROOT}/src/b.ts`], `${ROOT}/src`, false);
    expect(result).not.toBeNull();
    expect(result!.moveCalls).toHaveLength(1);
    expect(result!.moveCalls[0].srcAbsPath).toBe(`${ROOT}/a.ts`);
  });
});

describe("DnD drop — cycle guard", () => {
  it("shows warning toast and no ops when folder dropped into itself", async () => {
    const result = await executeDrop(
      [`${ROOT}/src`],
      `${ROOT}/src`, // dir === srcAbsPath → cycle
      false,
    );
    expect(result!.moveCalls).toHaveLength(0);
    const cycleToast = result!.toasts.find((t) => t.kind === "warning");
    expect(cycleToast).toBeDefined();
  });

  it("shows warning toast when folder dropped into descendant", async () => {
    const result = await executeDrop(
      [`${ROOT}/src`],
      `${ROOT}/src/subdir`, // descendant → cycle
      false,
    );
    expect(result!.moveCalls).toHaveLength(0);
    expect(result!.toasts.find((t) => t.kind === "warning")).toBeDefined();
  });
});

describe("DnD drop — partial failure", () => {
  it("shows error toast with M of N when first path fails", async () => {
    const failMap = new Map([[`${ROOT}/a.ts`, false]]);
    const result = await executeDrop(
      [`${ROOT}/a.ts`, `${ROOT}/b.ts`],
      `${ROOT}/src`,
      false,
      failMap,
    );
    const errorToast = result!.toasts.find(
      (t) => t.kind === "error" && t.message.includes("1 of 2"),
    );
    expect(errorToast).toBeDefined();
    // loadChildren called because b.ts succeeded.
    expect(result!.loadChildrenCalls).toHaveLength(1);
  });
});

describe("DnD drop — distinctParents in payload", () => {
  it("payload with parent+child → only parent moved (payload already reduced)", async () => {
    // Caller (row.tsx) applies distinctParents before building the payload.
    // Simulate that the payload arrived already reduced.
    // Drop onto /repo/lib (different dir) so self-drop guard does not fire.
    const reduced = distinctParents([`${ROOT}/src`, `${ROOT}/src/index.ts`]);
    const result = await executeDrop(reduced, `${ROOT}/lib`, false);
    expect(result).not.toBeNull();
    expect(result!.moveCalls).toHaveLength(1);
    expect(result!.moveCalls[0].srcAbsPath).toBe(`${ROOT}/src`);
  });
});
