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
import { isMac, SHORTCUTS } from "@/keybindings/shortcut-labels";
import type { useGroupActions } from "./use-group-actions";

type GroupActions = ReturnType<typeof useGroupActions>;

const REVEAL_LABEL = isMac ? i18next.t("action.reveal_in_finder") : i18next.t("action.reveal_in_explorer");

export interface TabContextInfo {
  isPinned: boolean;
  isEditor: boolean;
  /**
   * 터미널 탭일 때만 "Rename Tab" 항목을 노출하기 위한 플래그.
   * 사용자 요구: 자동 이름 갱신(OSC)이 있는 터미널 탭에서만 사용자 customTitle을
   * 덮어쓸 수 있게 한다. editor/browser/diff 탭은 시스템이 결정한 이름이 옳다고
   * 보고 rename UI를 노출하지 않는다.
   */
  isTerminal: boolean;
}

interface BuildOptions {
  context: TabContextInfo | null;
  actions: GroupActions;
  togglePin: () => void;
  copyPath: () => void;
  copyRelativePath: () => void;
  revealInFinder: () => void;
  /** "Rename Tab" 메뉴 항목 클릭 시 — inline 편집 모드 진입. */
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

  // 터미널 탭에 한해서 Rename 항목을 노출. 더블클릭 진입 경로와 동일한
  // 편집 모드(useTabEditingStore.startEditing)를 활성화한다.
  if (context.isTerminal) {
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
    items.push({
      kind: "item",
      label: REVEAL_LABEL,
      shortcut: SHORTCUTS.revealInOS,
      onSelect: revealInFinder,
    });
    items.push({ kind: "separator" });
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
