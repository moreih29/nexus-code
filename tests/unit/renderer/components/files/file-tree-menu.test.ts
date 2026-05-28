/**
 * Pure tests for buildFileTreeMenuItems.
 *
 * Phase C: accepts targets[] array instead of single target.
 *
 * The builder branches on the context target's type — verify that
 * directories don't see "Open" / "Open to the Side" (hide-not-disable),
 * that null targets produce an empty list, and that the leading
 * separator collapses cleanly when the file-only group is omitted (via
 * ContextMenuItems' separator collapsing — covered by the renderer
 * tests separately).
 *
 * New cases: N≥2 multi-select → only Cut/Copy/Paste/Delete exposed.
 */

import { describe, expect, it } from "bun:test";
import { buildFileTreeMenuItems } from "../../../../../src/renderer/components/files/file-tree/menu";
import type { useFileTreeActions } from "../../../../../src/renderer/components/files/hooks/use-file-tree-actions";

type Actions = ReturnType<typeof useFileTreeActions>;

const noopActions: Actions = {
  open: () => {},
  openToSide: () => {},
  copyPath: () => {},
  copyRelativePath: () => {},
  reveal: () => {},
  newFile: () => {},
  newFolder: () => {},
  rename: () => {},
  delete: async () => true,
  copy: () => {},
  cut: () => {},
  paste: () => {},
  canPaste: true,
};

function labelsOf(items: ReturnType<typeof buildFileTreeMenuItems>): string[] {
  return items
    .filter((it): it is Extract<typeof it, { kind: "item" }> => it.kind === "item")
    .map((it) => it.label);
}

describe("buildFileTreeMenuItems — single file target", () => {
  it("file target shows the open family + reveal + copy (NO New File/Folder)", () => {
    // VSCode parity: NEW_FILE / NEW_FOLDER are gated on `ExplorerFolderContext`
    // — they don't appear when the user right-clicks a file.
    const items = buildFileTreeMenuItems([{ absPath: "/repo/a.ts", type: "file" }], noopActions);
    expect(labelsOf(items)).toEqual([
      "Open",
      "Open to the Side",
      "Cut",
      "Copy",
      "Paste",
      "Rename",
      "Delete",
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
    ]);
  });

  it("directory target shows New File/Folder + Reveal + Copy (NO Open family)", () => {
    const items = buildFileTreeMenuItems([{ absPath: "/repo/dir", type: "dir" }], noopActions);
    expect(labelsOf(items)).toEqual([
      "New File",
      "New Folder",
      "Cut",
      "Copy",
      "Paste",
      "Rename",
      "Delete",
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
    ]);
  });

  it("symlink target follows the file branch (treated as file-like)", () => {
    const items = buildFileTreeMenuItems([{ absPath: "/repo/lnk", type: "symlink" }], noopActions);
    expect(labelsOf(items)).toEqual([
      "Open",
      "Open to the Side",
      "Cut",
      "Copy",
      "Paste",
      "Rename",
      "Delete",
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
      [{ absPath: "/repo", type: "dir", isRoot: true }],
      noopActions,
    );
    expect(labelsOf(items)).toEqual([
      "New File",
      "New Folder",
      "Paste",
      "Reveal in Finder",
      "Copy Path",
    ]);
  });

  it("disables Paste when the clipboard is empty", () => {
    const items = buildFileTreeMenuItems([{ absPath: "/repo/a.ts", type: "file" }], {
      ...noopActions,
      canPaste: false,
    });
    const paste = items.find(
      (it): it is Extract<typeof it, { kind: "item" }> =>
        it.kind === "item" && it.label === "Paste",
    );
    expect(paste?.disabled).toBe(true);
  });

  it("shows Rename with the F2 shortcut for non-root targets", () => {
    const items = buildFileTreeMenuItems([{ absPath: "/repo/a.ts", type: "file" }], noopActions);
    const rename = items.find(
      (it): it is Extract<typeof it, { kind: "item" }> =>
        it.kind === "item" && it.label === "Rename",
    );
    expect(rename?.shortcut).toBe("F2");
  });
});

describe("buildFileTreeMenuItems — empty targets array", () => {
  it("returns an empty list when there are no targets", () => {
    expect(buildFileTreeMenuItems([], noopActions)).toEqual([]);
  });
});

describe("buildFileTreeMenuItems — multi-select (N≥2)", () => {
  it("N=2 shows only Cut, Copy, Paste, Delete (no Open / New / Rename / Reveal)", () => {
    const items = buildFileTreeMenuItems(
      [
        { absPath: "/repo/a.ts", type: "file" },
        { absPath: "/repo/b.ts", type: "file" },
      ],
      noopActions,
    );
    expect(labelsOf(items)).toEqual(["Cut", "Copy", "Paste", "Delete"]);
  });

  it("N=3 also shows only Cut, Copy, Paste, Delete", () => {
    const items = buildFileTreeMenuItems(
      [
        { absPath: "/repo/a.ts", type: "file" },
        { absPath: "/repo/b.ts", type: "file" },
        { absPath: "/repo/c.ts", type: "file" },
      ],
      noopActions,
    );
    expect(labelsOf(items)).toEqual(["Cut", "Copy", "Paste", "Delete"]);
  });

  it("Paste is disabled when clipboard is empty in multi-select", () => {
    const items = buildFileTreeMenuItems(
      [
        { absPath: "/repo/a.ts", type: "file" },
        { absPath: "/repo/b.ts", type: "file" },
      ],
      { ...noopActions, canPaste: false },
    );
    const paste = items.find(
      (it): it is Extract<typeof it, { kind: "item" }> =>
        it.kind === "item" && it.label === "Paste",
    );
    expect(paste?.disabled).toBe(true);
  });

  it("multi-select with mixed dir+file also shows batch-safe menu only", () => {
    const items = buildFileTreeMenuItems(
      [
        { absPath: "/repo/a.ts", type: "file" },
        { absPath: "/repo/src", type: "dir" },
      ],
      noopActions,
    );
    expect(labelsOf(items)).toEqual(["Cut", "Copy", "Paste", "Delete"]);
    // Ensure single-only items are absent.
    const labels = labelsOf(items);
    expect(labels).not.toContain("Open");
    expect(labels).not.toContain("New File");
    expect(labels).not.toContain("Rename");
    expect(labels).not.toContain("Reveal in Finder");
  });
});
