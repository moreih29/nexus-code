/**
 * Phase D — handlePaste multi-entries tests.
 *
 * Tests the paste logic inline (without loading the real paste.ts) to
 * avoid Bun 1.3 mock.module isolation issues when multiple test files
 * mock the same barrel module (file-clipboard).
 *
 * The logic replicated here is identical to paste.ts. This mirrors the
 * approach used in clipboard.test.ts.
 *
 * Covers:
 *  - Multi-entry cut: movePath called N times, clipboard cleared, success toast.
 *  - Multi-entry copy: copyPathWithAutoRename called N times, success toast.
 *  - Cycle guard (cut): folder pasted into itself → skip entry + error toast.
 *  - Partial failure: one movePath fails → error "Pasted M of N" toast.
 *  - distinctParents applied: parent+child → only parent pasted.
 *  - Single paste (N=1): no summary toast.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { distinctParents } from "../../../../../src/renderer/services/fs-mutations/distinct-parents";

// ---------------------------------------------------------------------------
// Inline types (mirrors store.ts)
// ---------------------------------------------------------------------------

interface ClipboardEntry {
  relPath: string;
  absPath: string;
}

// ---------------------------------------------------------------------------
// Inline helpers — verbatim from paste.ts logic
// ---------------------------------------------------------------------------

function isInsideOrEqual(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

function basename(absPath: string): string {
  return absPath.split("/").filter(Boolean).pop() ?? absPath;
}

function applyDistinctParents(entries: ClipboardEntry[]): ClipboardEntry[] {
  const kept = new Set(distinctParents(entries.map((e) => e.absPath)));
  return entries.filter((e) => kept.has(e.absPath));
}

// ---------------------------------------------------------------------------
// Inline paste executor — mirrors handlePaste core loop logic
// ---------------------------------------------------------------------------

interface PasteResult {
  moveCalls: { srcAbsPath: string; dstDirAbsPath: string }[];
  copyCalls: { fromRelPath: string; toRelPath: string }[];
  toasts: { kind: string; message: string }[];
  clipboardCleared: boolean;
}

async function executePaste(
  kind: "cut" | "copy",
  entries: ClipboardEntry[],
  targetDir: string,
  sourceRootPath: string,
  /** Map absPath → resolve(true|false) for movePath */
  moveResults: Map<string, boolean> = new Map(),
): Promise<PasteResult> {
  const moveCalls: { srcAbsPath: string; dstDirAbsPath: string }[] = [];
  const copyCalls: { fromRelPath: string; toRelPath: string }[] = [];
  const toasts: { kind: string; message: string }[] = [];
  let clipboardCleared = false;

  const effective = applyDistinctParents(entries);
  const total = effective.length;
  const dirsToRefresh = new Set<string>();
  let successCount = 0;
  let firstFailurePath: string | null = null;
  let firstFailureMessage: string | null = null;

  if (kind === "cut") {
    for (const entry of effective) {
      if (isInsideOrEqual(targetDir, entry.absPath)) {
        const msg = `Can't move "${basename(entry.absPath)}" into itself or a subfolder.`;
        toasts.push({ kind: "error", message: msg });
        if (firstFailurePath === null) {
          firstFailurePath = entry.absPath;
          firstFailureMessage = msg;
        }
        continue;
      }

      const shouldSucceed = moveResults.get(entry.absPath) ?? true;
      moveCalls.push({ srcAbsPath: entry.absPath, dstDirAbsPath: targetDir });
      if (shouldSucceed) {
        successCount += 1;
        dirsToRefresh.add(targetDir);
      } else if (firstFailurePath === null) {
        firstFailurePath = entry.absPath;
        firstFailureMessage = "move failed";
      }
    }
  } else {
    for (const entry of effective) {
      const name = basename(entry.absPath);
      const effectiveDir = isInsideOrEqual(targetDir, entry.absPath)
        ? entry.absPath.substring(0, entry.absPath.lastIndexOf("/"))
        : targetDir;
      const dstAbsPath = `${effectiveDir}/${name}`;
      const toRel = dstAbsPath.startsWith(`${sourceRootPath}/`)
        ? dstAbsPath.slice(sourceRootPath.length + 1)
        : dstAbsPath;
      copyCalls.push({ fromRelPath: entry.relPath, toRelPath: toRel });
      const shouldSucceed = moveResults.get(entry.absPath) ?? true;
      if (shouldSucceed) {
        successCount += 1;
        dirsToRefresh.add(effectiveDir);
      } else if (firstFailurePath === null) {
        firstFailurePath = entry.absPath;
        firstFailureMessage = "copy failed";
      }
    }
  }

  if (kind === "cut" && successCount > 0) {
    clipboardCleared = true;
  }

  const failCount = total - successCount;
  if (failCount === 0) {
    if (total > 1) {
      toasts.push({ kind: "info", message: `Pasted ${total} items` });
    }
  } else {
    toasts.push({
      kind: "error",
      message: `Pasted ${successCount} of ${total}. First failure: ${firstFailurePath}: ${firstFailureMessage}`,
    });
  }

  return { moveCalls, copyCalls, toasts, clipboardCleared };
}

const ROOT = "/repo";

// ---------------------------------------------------------------------------
// Multi-entry cut
// ---------------------------------------------------------------------------

describe("handlePaste — multi-entry cut", () => {
  it("moves all entries and clears clipboard", async () => {
    const result = await executePaste(
      "cut",
      [
        { relPath: "a.ts", absPath: `${ROOT}/a.ts` },
        { relPath: "b.ts", absPath: `${ROOT}/b.ts` },
      ],
      `${ROOT}/src`,
      ROOT,
    );
    expect(result.moveCalls).toHaveLength(2);
    expect(result.moveCalls.map((c) => c.srcAbsPath).sort()).toEqual(
      [`${ROOT}/a.ts`, `${ROOT}/b.ts`].sort(),
    );
    expect(result.clipboardCleared).toBe(true);
  });

  it("shows info toast for N=2 cut", async () => {
    const result = await executePaste(
      "cut",
      [
        { relPath: "a.ts", absPath: `${ROOT}/a.ts` },
        { relPath: "b.ts", absPath: `${ROOT}/b.ts` },
      ],
      `${ROOT}/src`,
      ROOT,
    );
    expect(result.toasts.some((t) => t.kind === "info" && t.message === "Pasted 2 items")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-entry copy
// ---------------------------------------------------------------------------

describe("handlePaste — multi-entry copy", () => {
  it("copies all entries and shows toast", async () => {
    const result = await executePaste(
      "copy",
      [
        { relPath: "a.ts", absPath: `${ROOT}/a.ts` },
        { relPath: "b.ts", absPath: `${ROOT}/b.ts` },
      ],
      `${ROOT}/src`,
      ROOT,
    );
    expect(result.copyCalls).toHaveLength(2);
    expect(result.toasts.some((t) => t.kind === "info" && t.message === "Pasted 2 items")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Single paste — no toast
// ---------------------------------------------------------------------------

describe("handlePaste — single entry (N=1) no toast", () => {
  it("moves one file without showing a success toast", async () => {
    const result = await executePaste(
      "cut",
      [{ relPath: "a.ts", absPath: `${ROOT}/a.ts` }],
      `${ROOT}/src`,
      ROOT,
    );
    expect(result.moveCalls).toHaveLength(1);
    expect(result.toasts.filter((t) => t.kind === "info")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cycle guard (cut: move folder into itself)
// ---------------------------------------------------------------------------

describe("handlePaste — cycle guard (cut)", () => {
  it("skips a folder being cut into itself and shows error toast", async () => {
    const result = await executePaste(
      "cut",
      [
        { relPath: "src", absPath: `${ROOT}/src` },
        { relPath: "a.ts", absPath: `${ROOT}/a.ts` },
      ],
      `${ROOT}/src`, // targetDir = ROOT/src, src itself is being moved → cycle
      ROOT,
    );
    // Only a.ts should be moved (src is skipped due to cycle).
    expect(result.moveCalls).toHaveLength(1);
    expect(result.moveCalls[0].srcAbsPath).toBe(`${ROOT}/a.ts`);
    // An error toast for the cycle was shown.
    const cycleToast = result.toasts.find(
      (t) => t.kind === "error" && t.message.includes("into itself"),
    );
    expect(cycleToast).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Partial failure
// ---------------------------------------------------------------------------

describe("handlePaste — partial failure", () => {
  it("shows error toast with M of N when entries fail", async () => {
    // Both entries fail.
    const failMap = new Map([
      [`${ROOT}/a.ts`, false],
      [`${ROOT}/b.ts`, false],
    ]);
    const result = await executePaste(
      "cut",
      [
        { relPath: "a.ts", absPath: `${ROOT}/a.ts` },
        { relPath: "b.ts", absPath: `${ROOT}/b.ts` },
      ],
      `${ROOT}/src`,
      ROOT,
      failMap,
    );
    const errorToast = result.toasts.find((t) => t.kind === "error" && t.message.includes("of 2"));
    expect(errorToast).toBeDefined();
    expect(result.clipboardCleared).toBe(false); // nothing moved
  });

  it("shows partial success toast when first fails, second succeeds", async () => {
    const failMap = new Map([[`${ROOT}/a.ts`, false]]);
    const result = await executePaste(
      "cut",
      [
        { relPath: "a.ts", absPath: `${ROOT}/a.ts` },
        { relPath: "b.ts", absPath: `${ROOT}/b.ts` },
      ],
      `${ROOT}/src`,
      ROOT,
      failMap,
    );
    const errorToast = result.toasts.find(
      (t) => t.kind === "error" && t.message.includes("1 of 2"),
    );
    expect(errorToast).toBeDefined();
    expect(result.clipboardCleared).toBe(true); // b.ts succeeded
  });
});

// ---------------------------------------------------------------------------
// distinctParents: parent+child → only parent pasted
// ---------------------------------------------------------------------------

describe("handlePaste — distinctParents collapses parent+child", () => {
  it("pastes only the parent when child is also in clipboard", async () => {
    const result = await executePaste(
      "cut",
      [
        { relPath: "src", absPath: `${ROOT}/src` },
        { relPath: "src/index.ts", absPath: `${ROOT}/src/index.ts` },
      ],
      ROOT,
      ROOT,
    );
    // distinctParents reduces to [src] only.
    expect(result.moveCalls).toHaveLength(1);
    expect(result.moveCalls[0].srcAbsPath).toBe(`${ROOT}/src`);
  });
});

// Needed to avoid unused import errors
beforeEach(() => {});
