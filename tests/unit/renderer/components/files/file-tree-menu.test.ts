/**
 * Pure tests for buildFileTreeMenuItems.
 *
 * The builder branches on the context target's type — verify that
 * directories don't see "Open" / "Open to the Side" (hide-not-disable),
 * that null targets produce an empty list, and that the leading
 * separator collapses cleanly when the file-only group is omitted (via
 * ContextMenuItems' separator collapsing — covered by the renderer
 * tests separately).
 */

import { describe, expect, it } from "bun:test";
import { buildFileTreeMenuItems } from "../../../../../src/renderer/components/files/file-tree-menu";
import type { useFileTreeActions } from "../../../../../src/renderer/components/files/use-file-tree-actions";

type Actions = ReturnType<typeof useFileTreeActions>;

const noopActions: Actions = {
  open: () => {},
  openToSide: () => {},
  copyPath: () => {},
  copyRelativePath: () => {},
  reveal: () => {},
  newFile: () => {},
  newFolder: () => {},
};

function labelsOf(items: ReturnType<typeof buildFileTreeMenuItems>): string[] {
  return items
    .filter((it): it is Extract<typeof it, { kind: "item" }> => it.kind === "item")
    .map((it) => it.label);
}

describe("buildFileTreeMenuItems", () => {
  it("returns an empty list when there is no target", () => {
    expect(buildFileTreeMenuItems(null, noopActions)).toEqual([]);
  });

  it("file target shows the open family + reveal + copy (NO New File/Folder)", () => {
    // VSCode parity: NEW_FILE / NEW_FOLDER are gated on `ExplorerFolderContext`
    // — they don't appear when the user right-clicks a file.
    const items = buildFileTreeMenuItems({ absPath: "/repo/a.ts", type: "file" }, noopActions);
    expect(labelsOf(items)).toEqual([
      "Open",
      "Open to the Side",
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
    ]);
  });

  it("directory target shows New File/Folder + Reveal + Copy (NO Open family)", () => {
    const items = buildFileTreeMenuItems({ absPath: "/repo/dir", type: "dir" }, noopActions);
    expect(labelsOf(items)).toEqual([
      "New File",
      "New Folder",
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
    ]);
  });

  it("symlink target follows the file branch (treated as file-like)", () => {
    const items = buildFileTreeMenuItems({ absPath: "/repo/lnk", type: "symlink" }, noopActions);
    expect(labelsOf(items)).toEqual([
      "Open",
      "Open to the Side",
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
    ]);
  });

  it("root-context (empty area click) shows New + Reveal + Copy Path, omits Copy Relative Path", () => {
    // Right-clicking an empty area in the tree synthesises this target so
    // the user can still create files at the root. Copy Relative Path is
    // omitted because the workspace-relative path of the root is "".
    const items = buildFileTreeMenuItems(
      { absPath: "/repo", type: "dir", isRoot: true },
      noopActions,
    );
    expect(labelsOf(items)).toEqual(["New File", "New Folder", "Reveal in Finder", "Copy Path"]);
  });
});
