/**
 * Pure builder for the tab-strip right-click menu spec.
 *
 * The menu shape branches on the context tab's type (editor vs terminal)
 * and on its `isPinned` flag, all of which is plain data — keeping the
 * builder out of the React component lets it be unit-tested without
 * mounting Radix or the tab tree.
 */
import type { MenuItemSpec } from "@/components/ui/context-menu";
import type { useGroupActions } from "./use-group-actions";

type GroupActions = ReturnType<typeof useGroupActions>;

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
    onSelect: togglePin,
  });
  items.push({ kind: "separator" });

  items.push({ kind: "item", label: "Close", onSelect: actions.close });
  items.push({ kind: "item", label: "Close Others", onSelect: actions.closeOthers });
  items.push({
    kind: "item",
    label: "Close All to the Right",
    onSelect: actions.closeAllToRight,
  });
  items.push({ kind: "item", label: "Close Saved", onSelect: actions.closeSaved });
  items.push({ kind: "item", label: "Close All", onSelect: actions.closeAll });
  items.push({ kind: "separator" });

  items.push({ kind: "item", label: "Split Right", shortcut: "⌘\\", onSelect: actions.splitRight });
  items.push({ kind: "item", label: "Split Down", shortcut: "⌘⇧\\", onSelect: actions.splitDown });

  if (context.isEditor) {
    items.push({ kind: "separator" });
    items.push({ kind: "item", label: "Reveal in Finder", onSelect: revealInFinder });
    items.push({ kind: "separator" });
    items.push({ kind: "item", label: "Copy Path", onSelect: copyPath });
    items.push({ kind: "item", label: "Copy Relative Path", onSelect: copyRelativePath });
  }

  return items;
}
