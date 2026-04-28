import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  EditorPaneId,
  EditorPaneState,
  EditorStoreState,
  EditorTabId,
} from "../stores/editor-store";
import { cn } from "@/lib/utils";
import { EditorPane } from "./EditorPane";

export interface SplitEditorPaneProps {
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspaceName?: string | null;
  panes: EditorPaneState[];
  activePaneId: EditorPaneId;
  onActivatePane(paneId: EditorPaneId): void;
  onSplitRight(): void;
  onActivateTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCloseTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: EditorStoreState["applyWorkspaceEdit"];
}

export function SplitEditorPane({
  activeWorkspaceId,
  activeWorkspaceName,
  panes,
  activePaneId,
  onActivatePane,
  onSplitRight,
  onActivateTab,
  onCloseTab,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
}: SplitEditorPaneProps): JSX.Element {
  return (
    <section data-component="split-editor-pane" className="flex h-full min-h-0 min-w-0 bg-background">
      {panes.map((pane, index) => {
        const workspaceTabs = activeWorkspaceId
          ? pane.tabs.filter((tab) => tab.workspaceId === activeWorkspaceId)
          : [];
        const activeTabId = workspaceTabs.some((tab) => tab.id === pane.activeTabId)
          ? pane.activeTabId
          : null;
        const active = pane.id === activePaneId;

        return (
          <div
            key={pane.id}
            data-editor-split-pane={pane.id}
            className={cn(
              "min-h-0 min-w-0 flex-1",
              index > 0 && "border-l border-border",
            )}
          >
            <EditorPane
              activeWorkspaceName={activeWorkspaceName}
              paneId={pane.id}
              active={active}
              tabs={workspaceTabs}
              activeTabId={activeTabId}
              onActivatePane={onActivatePane}
              onActivateTab={(tabId) => onActivateTab(pane.id, tabId)}
              onCloseTab={(tabId) => onCloseTab(pane.id, tabId)}
              onSaveTab={onSaveTab}
              onChangeContent={onChangeContent}
              onApplyWorkspaceEdit={onApplyWorkspaceEdit}
              onSplitRight={onSplitRight}
            />
          </div>
        );
      })}
    </section>
  );
}
