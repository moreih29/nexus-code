import i18next from "i18next";
import type { MenuItemSpec } from "@/components/ui/context-menu";
import { SHORTCUTS } from "@/keybindings/shortcut-labels";
import { revealInOSLabel } from "@/utils/reveal-label";
import type { FileTreeActionTarget, useFileTreeActions } from "../hooks/use-file-tree-actions";

type FileTreeActions = ReturnType<typeof useFileTreeActions>;

export function buildFileTreeMenuItems(
  targets: FileTreeActionTarget[],
  actions: FileTreeActions,
): MenuItemSpec[] {
  if (targets.length === 0) return [];

  if (targets.length >= 2) {
    const items: MenuItemSpec[] = [];
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.cut"),
      shortcut: SHORTCUTS.fileCut || undefined,
      onSelect: actions.cut,
    });
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.copy"),
      shortcut: SHORTCUTS.fileCopy || undefined,
      onSelect: actions.copy,
    });
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.paste"),
      shortcut: SHORTCUTS.filePaste || undefined,
      disabled: !actions.canPaste,
      onSelect: actions.paste,
    });
    items.push({ kind: "separator" });
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.delete"),
      shortcut: SHORTCUTS.fileDelete || undefined,
      onSelect: actions.delete,
    });
    return items;
  }

  const target = targets[0];
  const items: MenuItemSpec[] = [];
  const isDir = target.type === "dir";
  const isRoot = !!target.isRoot;

  if (isDir) {
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.newFile"),
      onSelect: actions.newFile,
    });
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.newFolder"),
      onSelect: actions.newFolder,
    });
    items.push({ kind: "separator" });
  }

  if (!isDir) {
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.open"),
      onSelect: actions.open,
    });
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.openToSide"),
      shortcut: SHORTCUTS.openToSide,
      onSelect: actions.openToSide,
    });
    items.push({ kind: "separator" });
  }

  if (!isRoot) {
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.cut"),
      shortcut: SHORTCUTS.fileCut || undefined,
      onSelect: actions.cut,
    });
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.copy"),
      shortcut: SHORTCUTS.fileCopy || undefined,
      onSelect: actions.copy,
    });
  }
  items.push({
    kind: "item",
    label: i18next.t("files:fileTree.menu.paste"),
    shortcut: SHORTCUTS.filePaste || undefined,
    disabled: !actions.canPaste,
    onSelect: actions.paste,
  });
  items.push({ kind: "separator" });

  if (!isRoot) {
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.rename"),
      shortcut: SHORTCUTS.fileRename || undefined,
      onSelect: actions.rename,
    });
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.delete"),
      shortcut: SHORTCUTS.fileDelete || undefined,
      onSelect: actions.delete,
    });
    items.push({ kind: "separator" });
  }

  if (actions.reveal) {
    items.push({
      kind: "item",
      label: revealInOSLabel(),
      shortcut: SHORTCUTS.revealInOS,
      onSelect: actions.reveal,
    });
    items.push({ kind: "separator" });
  }
  items.push({
    kind: "item",
    label: i18next.t("files:fileTree.menu.copyPath"),
    shortcut: SHORTCUTS.copyPath,
    onSelect: actions.copyPath,
  });

  if (!isRoot) {
    items.push({
      kind: "item",
      label: i18next.t("files:fileTree.menu.copyRelativePath"),
      shortcut: SHORTCUTS.copyRelativePath,
      onSelect: actions.copyRelativePath,
    });
  }

  return items;
}
