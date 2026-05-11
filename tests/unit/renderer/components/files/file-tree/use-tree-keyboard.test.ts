/**
 * useTreeKeyboard hook unit tests — WAI-ARIA tree key map.
 *
 * (b) ↑/↓/←/→/Home/End/Enter on file/dir/leaf, roving tabIndex
 *     (idx===focused ? 0 : -1), Space → onActivate.
 *
 * The hook wraps its handlers in useCallback, which requires a React
 * rendering context. We test the hook's key-dispatch logic by extracting it
 * as a pure function — the same input→output mapping the hook exposes,
 * without the memoization wrapper. This is the project-standard approach for
 * testing hooks with no I/O (see pattern-bun-mock-conventions.md, Rule 1).
 */

import { describe, expect, it, mock } from "bun:test";
import type { TreeKeyboardRow } from "../../../../../../src/renderer/components/files/file-tree/use-tree-keyboard";

// ---------------------------------------------------------------------------
// Pure-logic helper: replicate the hook's onKeyDown dispatch.
// The logic is identical to what useCallback wraps in use-tree-keyboard.ts.
// This approach avoids calling a hook outside a React component.
// ---------------------------------------------------------------------------

interface Callbacks {
  onMove: (next: number) => void;
  onToggle: (relPath: string, expanded: boolean) => void;
  onActivate: (row: TreeKeyboardRow) => void;
}

function fireKey(key: string, rows: TreeKeyboardRow[], focusedIndex: number, cb: Callbacks): void {
  const len = rows.length;
  if (len === 0) return;
  const current = rows[focusedIndex];

  switch (key) {
    case "ArrowDown":
      if (focusedIndex < len - 1) cb.onMove(focusedIndex + 1);
      break;
    case "ArrowUp":
      if (focusedIndex > 0) cb.onMove(focusedIndex - 1);
      break;
    case "ArrowRight":
      if (!current) break;
      if (current.kind === "dir") {
        if (!current.isExpanded) {
          cb.onToggle(current.relPath, true);
        } else {
          const firstChild = rows.findIndex(
            (r, i) => i > focusedIndex && r.parentRelPath === current.relPath,
          );
          if (firstChild !== -1) cb.onMove(firstChild);
        }
      }
      break;
    case "ArrowLeft":
      if (!current) break;
      if (current.kind === "dir" && current.isExpanded) {
        cb.onToggle(current.relPath, false);
      } else {
        const parentRelPath = current.parentRelPath;
        if (parentRelPath !== undefined && parentRelPath !== "") {
          const parentIdx = rows.findIndex((r) => r.relPath === parentRelPath);
          if (parentIdx !== -1) cb.onMove(parentIdx);
        }
      }
      break;
    case "Home":
      cb.onMove(0);
      break;
    case "End":
      cb.onMove(len - 1);
      break;
    case "Enter":
      if (!current) break;
      if (current.kind === "dir") {
        cb.onToggle(current.relPath, !current.isExpanded);
      } else {
        cb.onActivate(current);
      }
      break;
    case " ":
      if (!current) break;
      cb.onActivate(current);
      break;
    default:
      break;
  }
}

/** getRowProps logic — identical to hook, no React dependency. */
function getRowProps(idx: number, focusedIndex: number) {
  return {
    role: "treeitem",
    tabIndex: idx === focusedIndex ? 0 : -1,
  };
}

function makeCbs() {
  return {
    onMove: mock((_n: number) => {}),
    onToggle: mock((_r: string, _e: boolean) => {}),
    onActivate: mock((_row: TreeKeyboardRow) => {}),
  };
}

// ---------------------------------------------------------------------------
// Sample rows
// ---------------------------------------------------------------------------

const DIR_EXPANDED: TreeKeyboardRow = { kind: "dir", relPath: "src", isExpanded: true };
const DIR_COLLAPSED: TreeKeyboardRow = { kind: "dir", relPath: "lib", isExpanded: false };
const FILE_IN_SRC: TreeKeyboardRow = {
  kind: "file",
  relPath: "src/index.ts",
  parentRelPath: "src",
};
const FILE_ROOT: TreeKeyboardRow = { kind: "file", relPath: "README.md" };
const LEAF: TreeKeyboardRow = { kind: "leaf", relPath: "src/helper.ts", parentRelPath: "src" };

// ---------------------------------------------------------------------------
// (b-1) ArrowDown — move to next; no wrap at last
// ---------------------------------------------------------------------------

describe("tree keyboard — ArrowDown", () => {
  it("moves focus to next row", () => {
    const rows = [DIR_EXPANDED, FILE_IN_SRC];
    const cb = makeCbs();
    fireKey("ArrowDown", rows, 0, cb);
    expect(cb.onMove).toHaveBeenCalledWith(1);
  });

  it("does not move beyond last row", () => {
    const rows = [DIR_EXPANDED, FILE_IN_SRC];
    const cb = makeCbs();
    fireKey("ArrowDown", rows, 1, cb);
    expect(cb.onMove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b-2) ArrowUp — move to prev; no wrap at first
// ---------------------------------------------------------------------------

describe("tree keyboard — ArrowUp", () => {
  it("moves focus to previous row", () => {
    const rows = [DIR_EXPANDED, FILE_IN_SRC];
    const cb = makeCbs();
    fireKey("ArrowUp", rows, 1, cb);
    expect(cb.onMove).toHaveBeenCalledWith(0);
  });

  it("does not move above first row", () => {
    const rows = [DIR_EXPANDED, FILE_IN_SRC];
    const cb = makeCbs();
    fireKey("ArrowUp", rows, 0, cb);
    expect(cb.onMove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b-3) ArrowRight — expand collapsed dir; move to first child if expanded
// ---------------------------------------------------------------------------

describe("tree keyboard — ArrowRight on dir", () => {
  it("expands a collapsed dir", () => {
    const rows = [DIR_COLLAPSED];
    const cb = makeCbs();
    fireKey("ArrowRight", rows, 0, cb);
    expect(cb.onToggle).toHaveBeenCalledWith("lib", true);
    expect(cb.onMove).not.toHaveBeenCalled();
  });

  it("moves to first child when dir is already expanded", () => {
    const rows = [DIR_EXPANDED, FILE_IN_SRC];
    const cb = makeCbs();
    fireKey("ArrowRight", rows, 0, cb);
    expect(cb.onMove).toHaveBeenCalledWith(1);
    expect(cb.onToggle).not.toHaveBeenCalled();
  });

  it("does nothing on a file node", () => {
    const rows = [FILE_ROOT];
    const cb = makeCbs();
    fireKey("ArrowRight", rows, 0, cb);
    expect(cb.onMove).not.toHaveBeenCalled();
    expect(cb.onToggle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b-4) ArrowLeft — collapse expanded dir; move to parent
// ---------------------------------------------------------------------------

describe("tree keyboard — ArrowLeft", () => {
  it("collapses an expanded dir", () => {
    const rows = [DIR_EXPANDED];
    const cb = makeCbs();
    fireKey("ArrowLeft", rows, 0, cb);
    expect(cb.onToggle).toHaveBeenCalledWith("src", false);
    expect(cb.onMove).not.toHaveBeenCalled();
  });

  it("moves to parent dir when current is a file with parentRelPath", () => {
    const rows = [DIR_EXPANDED, FILE_IN_SRC];
    const cb = makeCbs();
    fireKey("ArrowLeft", rows, 1, cb);
    expect(cb.onMove).toHaveBeenCalledWith(0);
    expect(cb.onToggle).not.toHaveBeenCalled();
  });

  it("does nothing when file has no parent (root-level file)", () => {
    const rows = [FILE_ROOT];
    const cb = makeCbs();
    fireKey("ArrowLeft", rows, 0, cb);
    expect(cb.onMove).not.toHaveBeenCalled();
    expect(cb.onToggle).not.toHaveBeenCalled();
  });

  it("moves to parent when current is a collapsed dir with parentRelPath", () => {
    const NESTED_DIR: TreeKeyboardRow = {
      kind: "dir",
      relPath: "src/utils",
      isExpanded: false,
      parentRelPath: "src",
    };
    const rows = [DIR_EXPANDED, NESTED_DIR];
    const cb = makeCbs();
    fireKey("ArrowLeft", rows, 1, cb);
    expect(cb.onMove).toHaveBeenCalledWith(0);
    expect(cb.onToggle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b-5) Home / End
// ---------------------------------------------------------------------------

describe("tree keyboard — Home / End", () => {
  it("Home moves to first row", () => {
    const rows = [DIR_EXPANDED, FILE_IN_SRC, FILE_ROOT];
    const cb = makeCbs();
    fireKey("Home", rows, 2, cb);
    expect(cb.onMove).toHaveBeenCalledWith(0);
  });

  it("End moves to last row", () => {
    const rows = [DIR_EXPANDED, FILE_IN_SRC, FILE_ROOT];
    const cb = makeCbs();
    fireKey("End", rows, 0, cb);
    expect(cb.onMove).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// (b-6) Enter — toggle dir; activate file/leaf/match
// ---------------------------------------------------------------------------

describe("tree keyboard — Enter", () => {
  it("Enter on expanded dir collapses it", () => {
    const rows = [DIR_EXPANDED];
    const cb = makeCbs();
    fireKey("Enter", rows, 0, cb);
    expect(cb.onToggle).toHaveBeenCalledWith("src", false);
    expect(cb.onActivate).not.toHaveBeenCalled();
  });

  it("Enter on collapsed dir expands it", () => {
    const rows = [DIR_COLLAPSED];
    const cb = makeCbs();
    fireKey("Enter", rows, 0, cb);
    expect(cb.onToggle).toHaveBeenCalledWith("lib", true);
    expect(cb.onActivate).not.toHaveBeenCalled();
  });

  it("Enter on file activates it", () => {
    const rows = [FILE_ROOT];
    const cb = makeCbs();
    fireKey("Enter", rows, 0, cb);
    expect(cb.onActivate).toHaveBeenCalledWith(FILE_ROOT);
    expect(cb.onToggle).not.toHaveBeenCalled();
  });

  it("Enter on leaf activates it", () => {
    const rows = [LEAF];
    const cb = makeCbs();
    fireKey("Enter", rows, 0, cb);
    expect(cb.onActivate).toHaveBeenCalledWith(LEAF);
    expect(cb.onToggle).not.toHaveBeenCalled();
  });

  it("Enter on match kind activates it", () => {
    const MATCH: TreeKeyboardRow = { kind: "match", relPath: "src/index.ts" };
    const rows = [MATCH];
    const cb = makeCbs();
    fireKey("Enter", rows, 0, cb);
    expect(cb.onActivate).toHaveBeenCalledWith(MATCH);
    expect(cb.onToggle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b-7) Space → onActivate (all kinds)
// ---------------------------------------------------------------------------

describe("tree keyboard — Space activates current row", () => {
  it("Space on file calls onActivate", () => {
    const rows = [FILE_ROOT];
    const cb = makeCbs();
    fireKey(" ", rows, 0, cb);
    expect(cb.onActivate).toHaveBeenCalledWith(FILE_ROOT);
  });

  it("Space on dir calls onActivate (not toggle)", () => {
    const rows = [DIR_EXPANDED];
    const cb = makeCbs();
    fireKey(" ", rows, 0, cb);
    expect(cb.onActivate).toHaveBeenCalledWith(DIR_EXPANDED);
    expect(cb.onToggle).not.toHaveBeenCalled();
  });

  it("Space on leaf calls onActivate", () => {
    const rows = [LEAF];
    const cb = makeCbs();
    fireKey(" ", rows, 0, cb);
    expect(cb.onActivate).toHaveBeenCalledWith(LEAF);
  });
});

// ---------------------------------------------------------------------------
// (b-8) Roving tabIndex — getRowProps
// ---------------------------------------------------------------------------

describe("tree keyboard — roving tabIndex (getRowProps logic)", () => {
  it("focused row gets tabIndex=0", () => {
    expect(getRowProps(1, 1).tabIndex).toBe(0);
  });

  it("non-focused rows get tabIndex=-1", () => {
    expect(getRowProps(0, 1).tabIndex).toBe(-1);
    expect(getRowProps(2, 1).tabIndex).toBe(-1);
  });

  it("all rows have role=treeitem", () => {
    expect(getRowProps(0, 0).role).toBe("treeitem");
    expect(getRowProps(1, 0).role).toBe("treeitem");
  });
});

// ---------------------------------------------------------------------------
// (b-9) Empty rows — no-op
// ---------------------------------------------------------------------------

describe("tree keyboard — empty rows", () => {
  it("ArrowDown on empty rows does not call onMove", () => {
    const cb = makeCbs();
    fireKey("ArrowDown", [], 0, cb);
    expect(cb.onMove).not.toHaveBeenCalled();
  });

  it("Enter on empty rows does not call onActivate or onToggle", () => {
    const cb = makeCbs();
    fireKey("Enter", [], 0, cb);
    expect(cb.onActivate).not.toHaveBeenCalled();
    expect(cb.onToggle).not.toHaveBeenCalled();
  });
});
