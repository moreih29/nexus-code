/**
 * Pure builder for the tab-strip right-click menu spec.
 *
 * The menu shape branches on the context tab's type (editor vs terminal)
 * and on its `isPinned` flag, all of which is plain data — keeping the
 * builder out of the React component lets it be unit-tested without
 * mounting Radix or the tab tree.
 */
import type { MenuItemSpec } from "@/components/ui/context-menu";
import { isMac, SHORTCUTS } from "@/keybindings/shortcut-labels";
import type { useGroupActions } from "./use-group-actions";

type GroupActions = ReturnType<typeof useGroupActions>;

const REVEAL_LABEL = isMac ? "Reveal in Finder" : "Reveal in File Explorer";

export interface TabContextInfo {
  isPinned: boolean;
  isEditor: boolean;
}

interface BuildOptions {
  context: TabContextInfo | null;
  actions: GroupActions;
  togglePin: () => void;
  copyPath: () => void;
  copyRelativePath: () => void;
  revealInFinder: () => void;
}

export function buildGroupTabBarMenuItems({
  context,
  actions,
  togglePin,
  copyPath,
  copyRelativePath,
  revealInFinder,
}: BuildOptions): MenuItemSpec[] {
  if (!context) return [];

  const items: MenuItemSpec[] = [];

  items.push({
    kind: "item",
    label: context.isPinned ? "Unpin Tab" : "Pin Tab",
    shortcut: SHORTCUTS.pinTab,
    onSelect: togglePin,
  });
  items.push({ kind: "separator" });

  items.push({
    kind: "item",
    label: "Close",
    shortcut: SHORTCUTS.closeTab,
    onSelect: actions.close,
  });
  items.push({
    kind: "item",
    label: "Close Others",
    shortcut: SHORTCUTS.closeOthers || undefined,
    onSelect: actions.closeOthers,
  });
  items.push({
    kind: "item",
    label: "Close All to the Right",
    onSelect: actions.closeAllToRight,
  });
  items.push({
    kind: "item",
    label: "Close Saved",
    shortcut: SHORTCUTS.closeSaved,
    onSelect: actions.closeSaved,
  });
  items.push({
    kind: "item",
    label: "Close All",
    shortcut: SHORTCUTS.closeAll,
    onSelect: actions.closeAll,
  });
  items.push({ kind: "separator" });

  items.push({
    kind: "item",
    label: "Split Right",
    shortcut: SHORTCUTS.splitRight,
    onSelect: actions.splitRight,
  });
  items.push({
    kind: "item",
    label: "Split Down",
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
      label: "Copy Path",
      shortcut: SHORTCUTS.copyPath,
      onSelect: copyPath,
    });
    items.push({
      kind: "item",
      label: "Copy Relative Path",
      shortcut: SHORTCUTS.copyRelativePath,
      onSelect: copyRelativePath,
    });
  }

  return items;
}
