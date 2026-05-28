/**
 * Phase F — isCut overlay tests.
 *
 * Verifies that:
 *   - isCut=true → opacity-40 class appears on the row (cut dim effect).
 *   - isCut=false → opacity-40 is absent.
 *   - row id prop is forwarded to the button element.
 */

import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTreeRow } from "../../../../../src/renderer/components/files/file-tree/row";
import type { TreeNode } from "../../../../../src/renderer/state/stores/files";

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
      isCut: false,
      onToggle: () => {},
      onClick: () => {},
      ...props,
    }),
  );
}

// ---------------------------------------------------------------------------
// isCut overlay
// ---------------------------------------------------------------------------

describe("FileTreeRow isCut overlay — Phase F", () => {
  it("isCut=true → opacity-40 class present", () => {
    const html = renderRow({ isCut: true });
    expect(html).toContain("opacity-40");
  });

  it("isCut=false → opacity-40 class absent (from isCut; isDragging path doesn't apply)", () => {
    const html = renderRow({ isCut: false, isSelected: false });
    // opacity-40 is added only for isCut or isDragging; isDragging starts false.
    expect(html).not.toContain("opacity-40");
  });

  it("isCut=true also shows disabled-border class", () => {
    const html = renderRow({ isCut: true });
    expect(html).toContain("state-disabled-border");
  });
});

// ---------------------------------------------------------------------------
// row id prop
// ---------------------------------------------------------------------------

describe("FileTreeRow id prop — Phase F ARIA", () => {
  it("id prop is forwarded to the button element", () => {
    const html = renderRow({ id: "tree-row-_repo_a_ts" });
    expect(html).toContain('id="tree-row-_repo_a_ts"');
  });

  it("no id attribute when id prop is not provided", () => {
    const html = renderRow();
    // id should not appear as an attribute when omitted.
    expect(html).not.toMatch(/\bid="/);
  });
});
