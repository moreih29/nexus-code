/**
 * Pure builder for the file-tree right-click menu spec.
 *
 * Lives outside `file-tree.tsx` so the branching by node type (file vs
 * directory vs no-target) is a plain testable function — no React, no
 * Radix, no DOM. The component side just wires it into
 * <ContextMenuItems items={...} />.
 */
import type { MenuItemSpec } from "@/components/ui/context-menu";
import { isMac, SHORTCUTS } from "@/keybindings/shortcut-labels";
import type { FileTreeActionTarget, useFileTreeActions } from "./use-file-tree-actions";

type FileTreeActions = ReturnType<typeof useFileTreeActions>;

// `Reveal in Finder` is the macOS title; the underlying VSCode command
// (`revealFileInOS`) renames itself per platform — match here.
const REVEAL_LABEL = isMac ? "Reveal in Finder" : "Reveal in File Explorer";

export function buildFileTreeMenuItems(
  target: FileTreeActionTarget | null,
  actions: FileTreeActions,
): MenuItemSpec[] {
  if (!target) return [];

  const items: MenuItemSpec[] = [];
  const isDir = target.type === "dir";
  const isRoot = !!target.isRoot;

  // VSCode parity: New File / New Folder are dir-only
  // (`when: ExplorerFolderContext` in fileActions.contribution.ts).
  // Right-clicking a file should not offer them — the user can right-click
  // the parent folder instead. The synthetic root target also counts as a
  // dir, so empty-area right-click still gets these.
  if (isDir) {
    items.push({ kind: "item", label: "New File", onSelect: actions.newFile });
    items.push({ kind: "item", label: "New Folder", onSelect: actions.newFolder });
    items.push({ kind: "separator" });
  }

  // Inverse rule (VSCode `ExplorerFolderContext.toNegated()`): Open /
  // Open to the Side are file-only.
  if (!isDir) {
    items.push({ kind: "item", label: "Open", onSelect: actions.open });
    items.push({
      kind: "item",
      label: "Open to the Side",
      shortcut: SHORTCUTS.openToSide,
      onSelect: actions.openToSide,
    });
    items.push({ kind: "separator" });
  }

  // Reveal + Copy Path apply to every target. ContextMenuItems collapses
  // any orphaned separators automatically.
  items.push({
    kind: "item",
    label: REVEAL_LABEL,
    shortcut: SHORTCUTS.revealInOS,
    onSelect: actions.reveal,
  });
  items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: "Copy Path",
    shortcut: SHORTCUTS.copyPath,
    onSelect: actions.copyPath,
  });

  // Copy Relative Path is meaningless at the workspace root (would copy
  // an empty string). Hide it specifically there.
  if (!isRoot) {
    items.push({
      kind: "item",
      label: "Copy Relative Path",
      shortcut: SHORTCUTS.copyRelativePath,
      onSelect: actions.copyRelativePath,
    });
  }

  return items;
}
