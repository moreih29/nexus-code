import type { ReactNode } from "react";
import { Copy, ExternalLink, PanelRight, X } from "lucide-react";

import type { EditorPaneId, EditorTab, EditorTabId } from "../services/editor-model-service";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { isImeMenuSelectEvent, type MenuSelectEventLike } from "./file-tree-context-menu";

export type TabContextMenuActionId =
  | "close"
  | "close-others"
  | "close-right"
  | "close-all"
  | "copy-path"
  | "copy-relative-path"
  | "reveal"
  | "split-right";

export interface TabContextMenuProps {
  paneId: EditorPaneId;
  tab: EditorTab;
  tabs: readonly EditorTab[];
  children: ReactNode;
  onCloseTab?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseOtherTabs?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTabsToRight?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseAllTabs?(paneId: EditorPaneId): void;
  onCopyPath?(tab: EditorTab, pathKind: "absolute" | "relative"): void;
  onRevealInFinder?(tab: EditorTab): void;
  onSplitRight?(tab: EditorTab): void;
}

export interface TabMenuItemDescriptor {
  id: TabContextMenuActionId;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  separatorBefore?: boolean;
}

export function TabContextMenu({
  paneId,
  tab,
  tabs,
  children,
  ...handlers
}: TabContextMenuProps): JSX.Element {
  const items = createTabContextMenuItems({
    tab,
    tabs,
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-tab-context-menu="true" aria-label={`${tab.title} tab menu`}>
        {items.map((item) => (
          <TabContextMenuItem
            key={item.id}
            item={item}
            onSelect={(event) => {
              runTabContextMenuAction(event, item.id, paneId, tab, handlers);
            }}
          />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TabContextMenuItem({
  item,
  onSelect,
}: {
  item: TabMenuItemDescriptor;
  onSelect(event: MenuSelectEventLike): void;
}): JSX.Element {
  return (
    <>
      {item.separatorBefore ? <ContextMenuSeparator /> : null}
      <ContextMenuItem
        data-menu-item-id={item.id}
        disabled={item.disabled}
        title={item.disabledReason}
        onSelect={onSelect}
      >
        <TabMenuItemIcon id={item.id} />
        <span>{item.label}</span>
        {item.shortcut ? <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut> : null}
      </ContextMenuItem>
    </>
  );
}

export function createTabContextMenuItems({
  tab,
  tabs,
}: {
  tab: EditorTab;
  tabs: readonly EditorTab[];
}): TabMenuItemDescriptor[] {
  const tabIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
  const hasOtherTabs = tabs.some((candidate) => candidate.id !== tab.id);
  const hasTabsToRight = tabIndex >= 0 && tabIndex < tabs.length - 1;

  return [
    { id: "close", label: "Close", shortcut: "⌘W" },
    {
      id: "close-others",
      label: "Close Others",
      disabled: !hasOtherTabs,
      disabledReason: hasOtherTabs ? undefined : "No other tabs are open.",
    },
    {
      id: "close-right",
      label: "Close to the Right",
      disabled: !hasTabsToRight,
      disabledReason: hasTabsToRight ? undefined : "No tabs are open to the right.",
    },
    { id: "close-all", label: "Close All", shortcut: "⇧⌘W" },
    { id: "copy-path", label: "Copy Path", separatorBefore: true },
    { id: "copy-relative-path", label: "Copy Relative Path" },
    { id: "reveal", label: "Reveal in Finder" },
    { id: "split-right", label: "Split Right", shortcut: "⌘\\" },
  ];
}

export function runTabContextMenuAction(
  event: MenuSelectEventLike,
  actionId: TabContextMenuActionId,
  paneId: EditorPaneId,
  tab: EditorTab,
  handlers: Omit<TabContextMenuProps, "paneId" | "tab" | "tabs" | "children">,
): void {
  if (isImeMenuSelectEvent(event)) {
    event.preventDefault();
    return;
  }

  switch (actionId) {
    case "close":
      handlers.onCloseTab?.(paneId, tab.id);
      return;
    case "close-others":
      handlers.onCloseOtherTabs?.(paneId, tab.id);
      return;
    case "close-right":
      handlers.onCloseTabsToRight?.(paneId, tab.id);
      return;
    case "close-all":
      handlers.onCloseAllTabs?.(paneId);
      return;
    case "copy-path":
      handlers.onCopyPath?.(tab, "absolute");
      return;
    case "copy-relative-path":
      handlers.onCopyPath?.(tab, "relative");
      return;
    case "reveal":
      handlers.onRevealInFinder?.(tab);
      return;
    case "split-right":
      handlers.onSplitRight?.(tab);
      return;
  }
}

function TabMenuItemIcon({ id }: { id: TabContextMenuActionId }): JSX.Element {
  switch (id) {
    case "copy-path":
    case "copy-relative-path":
      return <Copy aria-hidden="true" className="text-muted-foreground" />;
    case "reveal":
      return <ExternalLink aria-hidden="true" className="text-muted-foreground" />;
    case "split-right":
      return <PanelRight aria-hidden="true" className="text-muted-foreground" />;
    default:
      return <X aria-hidden="true" className="text-muted-foreground" />;
  }
}
