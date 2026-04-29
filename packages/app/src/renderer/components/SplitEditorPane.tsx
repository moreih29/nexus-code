import type { JSX } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type {
  EditorPaneId,
  EditorPaneState,
  EditorTabId,
} from "../services/editor-types";
import { EditorPane } from "./EditorPane";

type ApplyWorkspaceEdit = (
  workspaceId: WorkspaceId,
  edit: LspWorkspaceEdit,
) => Promise<LspWorkspaceEditApplicationResult>;

export interface SplitEditorPaneProps {
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspaceName?: string | null;
  panes: EditorPaneState[];
  activePaneId: EditorPaneId;
  onActivatePane(paneId: EditorPaneId): void;
  onSplitRight(): void;
  onReorderTab(
    paneId: EditorPaneId,
    oldIndex: number,
    newIndex: number,
    workspaceId?: WorkspaceId | null,
  ): void;
  onMoveTabToPane(
    sourcePaneId: EditorPaneId,
    targetPaneId: EditorPaneId,
    tabId: EditorTabId,
    targetIndex: number,
    workspaceId?: WorkspaceId | null,
  ): void;
  onSplitTabRight(
    sourcePaneId: EditorPaneId,
    tabId: EditorTabId,
    workspaceId?: WorkspaceId | null,
  ): void;
  onOpenFileFromTreeDrop?(
    paneId: EditorPaneId,
    workspaceId: WorkspaceId,
    path: string,
  ): void;
  onActivateTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseOtherTabs?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTabsToRight?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseAllTabs?(paneId: EditorPaneId): void;
  onCopyTabPath?(tab: EditorPaneState["tabs"][number], pathKind: "absolute" | "relative"): void;
  onRevealTabInFinder?(tab: EditorPaneState["tabs"][number]): void;
  onTearOffTabToFloating?(paneId: EditorPaneId, tabId: EditorTabId): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: ApplyWorkspaceEdit;
}

export type SplitEditorPaneViewProps = SplitEditorPaneProps;

export function SplitEditorPane(props: SplitEditorPaneProps): JSX.Element {
  return <SplitEditorPaneView {...props} />;
}

export function SplitEditorPaneView({
  activeWorkspaceId,
  activeWorkspaceName,
  panes,
  activePaneId,
  onActivatePane,
  onSplitRight,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onCopyTabPath,
  onRevealTabInFinder,
  onTearOffTabToFloating,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
}: SplitEditorPaneViewProps): JSX.Element {
  const pane = panes.find((candidate) => candidate.id === activePaneId) ?? panes[0] ?? {
    id: activePaneId,
    tabs: [],
    activeTabId: null,
  };
  const workspaceTabs = activeWorkspaceId
    ? pane.tabs.filter((tab) => tab.workspaceId === activeWorkspaceId)
    : [];
  const activeTabId = pane.activeTabId && workspaceTabs.some((tab) => tab.id === pane.activeTabId)
    ? pane.activeTabId
    : workspaceTabs[0]?.id ?? null;

  return (
    <section
      data-component="split-editor-pane-compat"
      data-editor-pane-compat="single-pane"
      className="h-full min-h-0 min-w-0 bg-background"
    >
      <EditorPane
        activeWorkspaceName={activeWorkspaceName}
        paneId={pane.id}
        active
        tabs={workspaceTabs}
        activeTabId={activeTabId}
        onActivatePane={onActivatePane}
        onActivateTab={(tabId) => onActivateTab(pane.id, tabId)}
        onCloseTab={(tabId) => onCloseTab(pane.id, tabId)}
        onCloseOtherTabs={(tabId) => onCloseOtherTabs?.(pane.id, tabId)}
        onCloseTabsToRight={(tabId) => onCloseTabsToRight?.(pane.id, tabId)}
        onCloseAllTabs={() => onCloseAllTabs?.(pane.id)}
        onCopyTabPath={onCopyTabPath}
        onRevealTabInFinder={onRevealTabInFinder}
        onTearOffTabToFloating={(tabId) => onTearOffTabToFloating?.(pane.id, tabId)}
        onSaveTab={onSaveTab}
        onChangeContent={onChangeContent}
        onApplyWorkspaceEdit={onApplyWorkspaceEdit}
        onSplitRight={onSplitRight}
      />
    </section>
  );
}
