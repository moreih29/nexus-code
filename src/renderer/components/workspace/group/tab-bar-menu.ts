/**
 * Pure builder for the tab-strip right-click menu spec.
 *
 * The menu shape branches on the context tab's type (editor vs terminal)
 * and on its `isPinned` flag, all of which is plain data — keeping the
 * builder out of the React component lets it be unit-tested without
 * mounting Radix or the tab tree.
 */
import i18next from "i18next";
import type { MenuItemSpec } from "@/components/ui/context-menu";
import { SHORTCUTS } from "@/keybindings/shortcut-labels";
import { revealInOSLabel } from "@/utils/reveal-label";
import type { useGroupActions } from "./use-group-actions";

type GroupActions = ReturnType<typeof useGroupActions>;

export interface TabContextInfo {
  isPinned: boolean;
  isEditor: boolean;
  /**
   * Flag to show the "Rename Tab" item only for terminal tabs and Claude tabs.
   * Only terminal tabs have automatic renaming (OSC), so only there can the user override
   * customTitle. A Claude tab's name becomes the name of that session (/rename).
   * For editor/browser/diff tabs the system-decided name is considered right, so no rename
   * UI is shown.
   */
  canRename: boolean;
}

interface BuildOptions {
  context: TabContextInfo | null;
  actions: GroupActions;
  togglePin: () => void;
  copyPath: () => void;
  copyRelativePath: () => void;
  /** Absent in a remote workspace, where the system file manager cannot help. */
  revealInFinder?: () => void;
  /** When the "Rename Tab" menu item is clicked — enters inline edit mode. */
  renameTab: () => void;
}

export function buildGroupTabBarMenuItems({
  context,
  actions,
  togglePin,
  copyPath,
  copyRelativePath,
  revealInFinder,
  renameTab,
}: BuildOptions): MenuItemSpec[] {
  if (!context) return [];

  const items: MenuItemSpec[] = [];

  const t = i18next.t.bind(i18next);

  items.push({
    kind: "item",
    label: context.isPinned ? t("tabBar.unpin_tab") : t("tabBar.pin_tab"),
    shortcut: SHORTCUTS.pinTab,
    onSelect: togglePin,
  });

  // The Rename item is shown only for terminal and Claude tabs. It activates the same edit
  // mode (useTabEditingStore.startEditing) as the double-click entry path.
  if (context.canRename) {
    items.push({
      kind: "item",
      label: t("tabBar.rename_tab_menu"),
      onSelect: renameTab,
    });
  }

  items.push({ kind: "separator" });

  items.push({
    kind: "item",
    label: t("tabBar.close"),
    shortcut: SHORTCUTS.closeTab,
    onSelect: actions.close,
  });
  items.push({
    kind: "item",
    label: t("tabBar.close_others"),
    shortcut: SHORTCUTS.closeOthers || undefined,
    onSelect: actions.closeOthers,
  });
  items.push({
    kind: "item",
    label: t("tabBar.close_all_right"),
    onSelect: actions.closeAllToRight,
  });
  items.push({
    kind: "item",
    label: t("tabBar.close_saved"),
    shortcut: SHORTCUTS.closeSaved,
    onSelect: actions.closeSaved,
  });
  items.push({
    kind: "item",
    label: t("tabBar.close_all"),
    shortcut: SHORTCUTS.closeAll,
    onSelect: actions.closeAll,
  });
  items.push({ kind: "separator" });

  items.push({
    kind: "item",
    label: t("tabBar.split_right"),
    shortcut: SHORTCUTS.splitRight,
    onSelect: actions.splitRight,
  });
  items.push({
    kind: "item",
    label: t("tabBar.split_down"),
    shortcut: SHORTCUTS.splitDown,
    onSelect: actions.splitDown,
  });

  if (context.isEditor) {
    items.push({ kind: "separator" });
    if (revealInFinder) {
      items.push({
        kind: "item",
        label: revealInOSLabel(),
        shortcut: SHORTCUTS.revealInOS,
        onSelect: revealInFinder,
      });
      items.push({ kind: "separator" });
    }
    items.push({
      kind: "item",
      label: t("tabBar.copy_path"),
      shortcut: SHORTCUTS.copyPath,
      onSelect: copyPath,
    });
    items.push({
      kind: "item",
      label: t("tabBar.copy_relative_path"),
      shortcut: SHORTCUTS.copyRelativePath,
      onSelect: copyRelativePath,
    });
  }

  return items;
}
