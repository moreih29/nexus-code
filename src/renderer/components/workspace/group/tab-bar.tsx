/**
 * GroupTabBar — the tab strip for a layout leaf, plus its right-click
 * context menu (Pin / Close family / Split / Copy Path family for editor
 * tabs).
 *
 * The dumb `TabBar` lives in `tabs/` and is reused; this wrapper adds
 * the group-policy concerns: which actions to expose, which tab the
 * menu is currently anchored to. The menu *contents* live in
 * `group-tab-bar-menu.ts` as a pure builder so the branching logic can
 * be unit-tested without mounting React.
 */
import { useRef, useState } from "react";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createPathActions } from "@/services/fs-mutations";
import { toggleTabPin } from "@/state/operations";
import { useTabEditingStore } from "@/state/stores/tab-editing";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import type { ShellChoice } from "../../../../shared/pty/shell";
import { TabBar } from "../tabs/tab-bar";
import { buildGroupTabBarMenuItems, type TabContextInfo } from "./tab-bar-menu";
import { useGroupActions } from "./use-group-actions";

interface GroupTabBarProps {
  workspaceId: string;
  leafId: string;
  tabIds: string[];
  tabs: Tab[];
  activeTabId: string | null;
  workspaceRootPath: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTerminalTab: (shell?: ShellChoice) => void;
  onNewUntitledTab: () => void;
  onNewBrowserTab: () => void;
  onShowAgentList: () => void;
  /** Opens a new Claude tab, with that profile rather than the workspace's. */
  onNewClaudeTab: (profileId?: string) => void;
  onNewCodexTab: (profileId?: string) => void;
  onActivateGroup: (groupId: string) => void;
}

export function GroupTabBar({
  workspaceId,
  leafId,
  tabIds,
  tabs,
  activeTabId,
  workspaceRootPath,
  onSelectTab,
  onCloseTab,
  onNewTerminalTab,
  onNewUntitledTab,
  onNewBrowserTab,
  onShowAgentList,
  onNewClaudeTab,
  onNewCodexTab,
  onActivateGroup,
}: GroupTabBarProps) {
  const [contextTabId, setContextTabId] = useState<string | null>(null);

  // Focus handoff guard — after closing, Radix ContextMenu returns focus to the trigger by
  // default, and right after clicking Rename Tab… mounts the inline input, that focus return
  // triggers the input's blur at once, causing a commit→cancel→vanish flicker.
  // The file-tree inline edit already solves the same problem with the same pattern —
  // only when a handoff happens, onCloseAutoFocus.preventDefault() makes Radix step aside.
  const renameHandoffInFlight = useRef(false);

  const contextTab = contextTabId
    ? useTabsStore.getState().byWorkspace[workspaceId]?.[contextTabId]
    : null;
  const contextInfo: TabContextInfo | null = contextTab
    ? {
        isPinned: !!contextTab.isPinned,
        isEditor: contextTab.type === "editor",
        canRename:
          contextTab.type === "terminal" ||
          contextTab.type === "claude" ||
          contextTab.type === "codex",
      }
    : null;

  const actions = useGroupActions({
    workspaceId,
    leafId,
    workspaceRootPath,
    getContextTabId: () => contextTabId ?? "",
    getTabIds: () => tabIds,
    onActivateGroup,
  });

  // Anchor the path actions to whichever tab the menu currently points at.
  // The resolver returns null for non-editor tabs (terminals, etc.) so the
  // shared `createPathActions` no-ops cleanly without each menu callsite
  // re-checking tab type.
  const pathActions = createPathActions({
    workspaceId,
    workspaceRootPath,
    getAbsPath: () =>
      contextTab && contextTab.type === "editor" ? contextTab.props.filePath : null,
  });

  function togglePin() {
    if (!contextTabId) return;
    toggleTabPin(workspaceId, contextTabId);
  }

  function renameTab() {
    if (!contextTabId) return;
    // Radix returns focus to the trigger right when it closes, which leads to the input's blur
    // and causes commit→cancel→vanish. A flag is set just before closing so the
    // onCloseAutoFocus guard prevents it. Used once, then reset.
    renameHandoffInFlight.current = true;
    useTabEditingStore.getState().startEditing(contextTabId);
  }

  const isRemote = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location.kind !== "local",
  );

  const menuItems = buildGroupTabBarMenuItems({
    context: contextInfo,
    actions,
    togglePin,
    copyPath: pathActions.copyPath,
    copyRelativePath: pathActions.copyRelativePath,
    revealInFinder: isRemote ? undefined : pathActions.revealInFinder,
    renameTab,
  });

  return (
    <ContextMenuRoot onOpenChange={(open) => !open && setContextTabId(null)}>
      <ContextMenuTrigger>
        <div>
          <TabBar
            workspaceId={workspaceId}
            leafId={leafId}
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onNewTerminalTab={onNewTerminalTab}
            onNewUntitledTab={onNewUntitledTab}
            onNewBrowserTab={onNewBrowserTab}
            onShowAgentList={onShowAgentList}
            onNewClaudeTab={onNewClaudeTab}
            onNewCodexTab={onNewCodexTab}
            onTabContextMenu={(tabId) => setContextTabId(tabId)}
          />
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (renameHandoffInFlight.current) {
            e.preventDefault();
            renameHandoffInFlight.current = false;
          }
        }}
      >
        <ContextMenuItems items={menuItems} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
