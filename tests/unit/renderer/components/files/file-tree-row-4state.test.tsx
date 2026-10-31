/**
 * Phase B — FileTreeRow 4-state className mapping tests.
 *
 * Verifies that the correct CSS class fragments appear (or are absent) for
 * the four visual states: default, selected, focused, selected+focused.
 *
 * Uses renderToStaticMarkup (no DOM, no jsdom required) — the same pattern
 * used in git-context-menu.test.tsx and other renderer component tests.
 */

import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTreeRow } from "../../../../../src/renderer/components/files/file-tree/row";
import type { TreeNode } from "../../../../../src/renderer/state/stores/files";

// ---------------------------------------------------------------------------
// Minimal node fixture
// ---------------------------------------------------------------------------

const FILE_NODE: TreeNode = {
  absPath: "/repo/a.ts",
  name: "a.ts",
  type: "file",
  childrenLoaded: false,
  children: [],
};

function renderRow(props: Partial<React.ComponentProps<typeof FileTreeRow>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(FileTreeRow, {
      workspaceId: "ws",
      absPath: "/repo/a.ts",
      node: FILE_NODE,
      depth: 1,
      isExpanded: false,
      isSelected: false,
      isFocused: false,
      onClick: () => {},
      ...props,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileTreeRow 4-state", () => {
  it.each([
    { isSelected: false, isFocused: false, selectedBg: false, focusBorder: false },
    { isSelected: true, isFocused: false, selectedBg: true, focusBorder: false },
    { isSelected: false, isFocused: true, selectedBg: false, focusBorder: true },
    { isSelected: true, isFocused: true, selectedBg: true, focusBorder: true },
  ])("isSelected=$isSelected isFocused=$isFocused", ({
    isSelected,
    isFocused,
    selectedBg,
    focusBorder,
  }) => {
    const html = renderRow({ isSelected, isFocused });
    expect(html.includes("sidebar-item-selected-bg")).toBe(selectedBg);
    expect(html.includes("sidebar-item-focus-border")).toBe(focusBorder);
  });
});
