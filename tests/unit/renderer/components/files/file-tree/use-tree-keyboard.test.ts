/**
 * Key map tests for the WAI-ARIA tree keyboard handling.
 *
 * `useTreeKeyboard` wraps `handleTreeKey` in useCallback, so these tests call
 * `handleTreeKey` directly and record which callback each key fires.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  handleTreeKey,
  type TreeKeyboardRow,
} from "../../../../../../src/renderer/components/files/file-tree/use-tree-keyboard";

// Index: 0 src/ (expanded), 1 src/index.ts, 2 lib/ (collapsed), 3 README.md
const ROWS: TreeKeyboardRow[] = [
  { kind: "dir", relPath: "src", isExpanded: true },
  { kind: "file", relPath: "src/index.ts", parentRelPath: "src" },
  { kind: "dir", relPath: "lib", isExpanded: false },
  { kind: "file", relPath: "README.md" },
];

function press(key: string, rows: TreeKeyboardRow[], focusedIndex: number) {
  const calls: string[] = [];
  const preventDefault = mock(() => {});
  handleTreeKey(
    { key, preventDefault },
    {
      rows,
      focusedIndex,
      onMove: (next) => calls.push(`move ${next}`),
      onToggle: (relPath, expanded) => calls.push(`toggle ${relPath} ${expanded}`),
      onActivate: (row) => calls.push(`activate ${row.relPath}`),
    },
  );
  return { calls, preventDefault };
}

describe("handleTreeKey", () => {
  it.each([
    ["ArrowDown", 0, ["move 1"]],
    ["ArrowDown", 3, []], // no wrap past the last row
    ["ArrowUp", 1, ["move 0"]],
    ["ArrowUp", 0, []], // no wrap past the first row
    ["ArrowRight", 2, ["toggle lib true"]],
    ["ArrowRight", 0, ["move 1"]], // expanded dir → first child
    ["ArrowRight", 3, []],
    ["ArrowLeft", 0, ["toggle src false"]],
    ["ArrowLeft", 1, ["move 0"]], // child → parent dir
    ["ArrowLeft", 3, []], // root-level row has no parent
    ["Home", 3, ["move 0"]],
    ["End", 0, ["move 3"]],
    ["Enter", 0, ["toggle src false"]],
    ["Enter", 2, ["toggle lib true"]],
    ["Enter", 3, ["activate README.md"]],
    [" ", 0, ["activate src"]], // Space activates a dir instead of toggling it
  ] as const)("%p on row %i → %p", (key, focusedIndex, expected) => {
    expect(press(key, ROWS, focusedIndex).calls).toEqual([...expected]);
  });

  it("prevents default for tree keys even when they do nothing, but not for other keys", () => {
    expect(press("ArrowDown", ROWS, 3).preventDefault).toHaveBeenCalledTimes(1);
    expect(press("Tab", ROWS, 0).preventDefault).not.toHaveBeenCalled();
  });

  it("ignores every key when there are no rows", () => {
    for (const key of ["ArrowDown", "Home", "End", "Enter", " "]) {
      const { calls, preventDefault } = press(key, [], 0);
      expect(calls).toEqual([]);
      expect(preventDefault).not.toHaveBeenCalled();
    }
  });
});
