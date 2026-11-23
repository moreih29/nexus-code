import i18next from "i18next";
import type { MenuItemSpec } from "@/components/ui/context-menu";
import { SHORTCUTS } from "@/keybindings/shortcut-labels";

export function peerTabMenu(actions: {
  rename?: () => void;
  close: () => void;
  closeOthers: () => void;
  closeToRight: () => void;
  closeAll: () => void;
  copyPath?: () => void;
  copyRelativePath?: () => void;
}): MenuItemSpec[] {
  const t = i18next.t.bind(i18next);
  const items: MenuItemSpec[] = [];
  if (actions.rename) {
    items.push(
      { kind: "item", label: t("tabBar.rename_tab_menu"), onSelect: actions.rename },
      { kind: "separator" },
    );
  }
  items.push(
    {
      kind: "item",
      label: t("tabBar.close"),
      shortcut: SHORTCUTS.closeTab,
      onSelect: actions.close,
    },
    {
      kind: "item",
      label: t("tabBar.close_others"),
      shortcut: SHORTCUTS.closeOthers || undefined,
      onSelect: actions.closeOthers,
    },
    { kind: "item", label: t("tabBar.close_all_right"), onSelect: actions.closeToRight },
    {
      kind: "item",
      label: t("tabBar.close_all"),
      shortcut: SHORTCUTS.closeAll,
      onSelect: actions.closeAll,
    },
  );
  if (actions.copyPath && actions.copyRelativePath) {
    items.push(
      { kind: "separator" },
      {
        kind: "item",
        label: t("tabBar.copy_path"),
        shortcut: SHORTCUTS.copyPath,
        onSelect: actions.copyPath,
      },
      {
        kind: "item",
        label: t("tabBar.copy_relative_path"),
        shortcut: SHORTCUTS.copyRelativePath,
        onSelect: actions.copyRelativePath,
      },
    );
  }
  return items;
}
