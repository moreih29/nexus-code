import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import type { ClaudeSettingsConsentRequest } from "../../../../shared/src/contracts/claude/claude-settings";
import { CenterWorkbench } from "../components/CenterWorkbench";
import { ClaudeSettingsConsentDialog } from "../components/ClaudeSettingsConsentDialog";
import { CommandPalette } from "../components/CommandPalette";
import { FileTreePanel } from "../components/FileTreePanel";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { SearchPanel } from "../components/SearchPanel";
import { SessionHistoryPanel } from "../components/SessionHistoryPanel";
import { SourceControlPanel } from "../components/SourceControlPanel";
import { ToolFeedPanel } from "../components/ToolFeedPanel";
import { workspaceTabId } from "../components/WorkspaceStrip";
import { ActivityBarPart } from "../parts/activity-bar";
import { BottomPanelPart } from "../parts/bottom-panel";
import { EditorGroupsPart } from "../parts/editor-groups";
import { SideBarPart } from "../parts/side-bar";
import { WorkspaceStripPart } from "../parts/workspace-strip";
import { useAppServices } from "./wiring";
import { useAppCommands } from "./useAppCommands";
import { useEditorBindings } from "./useEditorBindings";
import { useExplorerBindings } from "./useExplorerBindings";
import { useResizeDrag } from "./useResizeDrag";
import { useSourceControlBindings } from "./useSourceControlBindings";

export { closeActiveEditorTabOrWorkspace, registerAppCommands } from "./commands";
export { unifiedDiffToSideContents } from "./useSourceControlBindings";

export default function App(): JSX.Element {
  const {
    workspace: workspaceStore,
    activityBar: activityBarStore,
    bottomPanel: bottomPanelStore,
    harnessBadge: harnessBadgeStore,
    harnessToolFeed: harnessToolFeedStore,
    harnessSession: harnessSessionStore,
    search: searchStore,
    sourceControl: sourceControlStore,
    fileClipboard: fileClipboardStore,
    files: filesService,
    editorDocuments: editorDocumentsService,
    editorGroups: editorGroupsService,
    editorWorkspace: editorWorkspaceService,
    git: gitService,
  } = useAppServices();
  const [claudeConsentRequest, setClaudeConsentRequest] =
    useState<ClaudeSettingsConsentRequest | null>(null);
  const [claudeConsentDontAskAgain, setClaudeConsentDontAskAgain] = useState(false);
  const pendingClaudeConsentRef = useRef<ClaudeSettingsConsentRequest | null>(null);

  const sidebarState = useStore(workspaceStore, (state) => state.sidebarState);
  const activityBarViews = useStore(activityBarStore, (state) => state.views);
  const activeActivityBarViewId = useStore(activityBarStore, (state) => state.activeViewId);
  const sideBarCollapsed = useStore(activityBarStore, (state) => state.sideBarCollapsed);
  const activeSideBarRoute = useMemo(() => {
    const activeView = activityBarViews.find((view) => view.id === activeActivityBarViewId) ?? null;
    return activeView
      ? { title: activeView.sideBarTitle, contentId: activeView.sideBarContentId }
      : null;
  }, [activityBarViews, activeActivityBarViewId]);
  const bottomPanelViews = useStore(bottomPanelStore, (state) => state.views);
  const activeBottomPanelViewId = useStore(bottomPanelStore, (state) => state.activeViewId);
  const bottomPanelPosition = useStore(bottomPanelStore, (state) => state.position);
  const bottomPanelExpanded = useStore(bottomPanelStore, (state) => state.expanded);
  const bottomPanelHeight = useStore(bottomPanelStore, (state) => state.height);
  const badgeByWorkspaceId = useStore(harnessBadgeStore, (state) => state.badgeByWorkspaceId);
  const toolFeedByWorkspaceId = useStore(harnessToolFeedStore, (state) => state.feedByWorkspaceId);
  const sessionByWorkspaceId = useStore(harnessSessionStore, (state) => state.sessionByWorkspaceId);
  const editorFileTree = useStore(filesService, (state) => state.fileTree);
  const editorExpandedPaths = useStore(filesService, (state) => state.expandedPaths);
  const editorGitBadgeByPath = useStore(gitService, (state) => state.pathBadgeByPath);
  const editorSelectedTreePath = useStore(filesService, (state) => state.selectedPath);
  const editorPendingExplorerEdit = useStore(filesService, (state) => state.pendingExplorerEdit);
  const editorPendingExplorerDelete = useStore(filesService, (state) => state.pendingExplorerDelete);
  const fileClipboardCanPaste = useStore(fileClipboardStore, (state) => state.hasClipboardItems());
  const fileClipboardPendingCollision = useStore(fileClipboardStore, (state) => state.pendingCollision);
  const activeWorkspace = sidebarState.activeWorkspaceId
    ? sidebarState.openWorkspaces.find((workspace) => workspace.id === sidebarState.activeWorkspaceId)
    : undefined;
  const activeWorkspaceTabId = activeWorkspace ? workspaceTabId(activeWorkspace.id) : undefined;
  const activeToolFeedEntries = useMemo(
    () => sidebarState.activeWorkspaceId
      ? (toolFeedByWorkspaceId[sidebarState.activeWorkspaceId] ?? [])
      : [],
    [sidebarState.activeWorkspaceId, toolFeedByWorkspaceId],
  );
  const activeSessionRef = sidebarState.activeWorkspaceId
    ? (sessionByWorkspaceId[sidebarState.activeWorkspaceId] ?? null)
    : null;

  const editorBindings = useEditorBindings({
    activeWorkspaceId: activeWorkspace?.id ?? null,
    documentsService: editorDocumentsService,
    filesService,
    gitService,
    groupsService: editorGroupsService,
    workspaceService: editorWorkspaceService,
  });
  const appCommands = useAppCommands({
    activityBarStore,
    bottomPanelStore,
    editorBindings,
    editorWorkspaceService,
    searchStore,
    workspaceStore,
  });
  const explorerBindings = useExplorerBindings({
    activeWorkspaceId: activeWorkspace?.id ?? null,
    documentsService: editorDocumentsService,
    fileClipboardStore,
    filesService,
    gitService,
    groupsService: editorGroupsService,
    showTerminalPanel: appCommands.showTerminalPanel,
    workspaceService: editorWorkspaceService,
  });
  const sourceControlBindings = useSourceControlBindings({
    activeWorkspace: activeWorkspace ?? null,
    documentsService: editorDocumentsService,
    groupsService: editorGroupsService,
    sourceControlStore,
    workspaceService: editorWorkspaceService,
  });
  const resizeBindings = useResizeDrag({ activityBarStore });

  const completeClaudeConsentRequest = useCallback((approved: boolean, dontAskAgain: boolean) => {
    const request = pendingClaudeConsentRef.current;
    if (!request) {
      return;
    }

    pendingClaudeConsentRef.current = null;
    setClaudeConsentRequest(null);
    setClaudeConsentDontAskAgain(false);
    void window.nexusClaudeSettings.respondConsentRequest({
      requestId: request.requestId,
      approved,
      dontAskAgain: approved ? dontAskAgain : false,
    }).catch((error) => {
      console.error("Claude settings consent: failed to send decision.", error);
    });
  }, []);

  useEffect(() => {
    const subscription = window.nexusClaudeSettings.onConsentRequest((request) => {
      if (pendingClaudeConsentRef.current) {
        completeClaudeConsentRequest(false, false);
      }

      pendingClaudeConsentRef.current = request;
      setClaudeConsentDontAskAgain(false);
      setClaudeConsentRequest(request);
    });

    return () => {
      subscription.dispose();
      completeClaudeConsentRequest(false, false);
    };
  }, [completeClaudeConsentRequest]);

  return (
    <div className="flex h-full bg-background text-foreground">
      <CommandPalette open={appCommands.commandPaletteOpen} onOpenChange={appCommands.setCommandPaletteOpen} />
      <ClaudeSettingsConsentDialog
        open={claudeConsentRequest !== null}
        workspaceName={claudeConsentRequest?.workspaceName ?? "this workspace"}
        harnessName={claudeConsentRequest?.harnessName}
        settingsFiles={claudeConsentRequest?.settingsFiles}
        settingsDescription={claudeConsentRequest?.settingsDescription}
        gitignoreEntries={claudeConsentRequest?.gitignoreEntries}
        dontAskAgain={claudeConsentDontAskAgain}
        onOpenChange={(open) => {
          if (!open) {
            completeClaudeConsentRequest(false, false);
          }
        }}
        onDontAskAgainChange={setClaudeConsentDontAskAgain}
        onApprove={(decision) => {
          completeClaudeConsentRequest(true, decision.dontAskAgain);
        }}
        onCancel={() => {
          completeClaudeConsentRequest(false, false);
        }}
      />

      <div className="flex min-w-0 flex-1">
        <div
          ref={resizeBindings.workspaceStrip.ref}
          data-panel="workspace-strip"
          className="min-h-0 shrink-0 overflow-hidden"
          style={{ flexBasis: resizeBindings.workspaceStrip.size, width: resizeBindings.workspaceStrip.size }}
        >
          <WorkspaceStripPart
            sidebarState={sidebarState}
            badgeByWorkspaceId={badgeByWorkspaceId}
            onOpenFolder={() => runSidebarMutation(appCommands.openFolder)}
            onActivateWorkspace={(workspaceId) =>
              runSidebarMutation(() => appCommands.activateWorkspace(workspaceId))
            }
            onCloseWorkspace={(workspaceId) =>
              runSidebarMutation(() => appCommands.closeWorkspace(workspaceId))
            }
          />
        </div>

        <PanelResizeHandle
          orientation="vertical"
          dragging={resizeBindings.draggingPanel === "workspaceStrip"}
          aria-valuemin={resizeBindings.workspaceStrip.minSize}
          aria-valuemax={resizeBindings.workspaceStrip.maxSize}
          aria-valuenow={Math.round(resizeBindings.workspaceStrip.size)}
          aria-label="Resize workspace strip"
          onKeyDown={resizeBindings.workspaceStrip.onKeyDown}
          onPointerDown={resizeBindings.workspaceStrip.onPointerDown}
        />

        <ActivityBarPart
          views={activityBarViews}
          activeViewId={activeActivityBarViewId}
          sideBarCollapsed={sideBarCollapsed}
          onActiveViewChange={appCommands.activateActivityBarView}
        />

        {!sideBarCollapsed && (
          <>
            <div
              ref={resizeBindings.sideBar.ref}
              data-panel="side-bar"
              className="min-h-0 shrink-0 overflow-hidden"
              style={{ flexBasis: resizeBindings.sideBar.size, width: resizeBindings.sideBar.size }}
            >
              <SideBarPart
                route={activeSideBarRoute}
                explorer={
                  <FileTreePanel
                    activeWorkspace={activeWorkspace ?? null}
                    workspaceTabId={activeWorkspaceTabId}
                    fileTree={editorFileTree}
                    expandedPaths={editorExpandedPaths}
                    gitBadgeByPath={editorGitBadgeByPath}
                    selectedTreePath={editorSelectedTreePath}
                    pendingExplorerEdit={editorPendingExplorerEdit}
                    pendingExplorerDelete={editorPendingExplorerDelete}
                    branchSubLine={sourceControlBindings.branchLine}
                    onRefresh={explorerBindings.refresh}
                    onToggleDirectory={explorerBindings.toggleDirectory}
                    onOpenFile={explorerBindings.openFile}
                    onOpenFileToSide={explorerBindings.openFileToSide}
                    onCreateNode={explorerBindings.createNode}
                    onDeleteNode={explorerBindings.deleteNode}
                    onRenameNode={explorerBindings.renameNode}
                    onSelectTreePath={explorerBindings.selectTreePath}
                    onBeginCreateFile={explorerBindings.beginCreateFile}
                    onBeginCreateFolder={explorerBindings.beginCreateFolder}
                    onBeginRename={explorerBindings.beginRename}
                    onBeginDelete={explorerBindings.beginDelete}
                    onCancelExplorerEdit={explorerBindings.cancelExplorerEdit}
                    onCollapseAll={explorerBindings.collapseAll}
                    onMoveTreeSelection={explorerBindings.moveTreeSelection}
                    onRevealInFinder={explorerBindings.revealInFinder}
                    onOpenWithSystemApp={explorerBindings.openWithSystemApp}
                    onOpenInTerminal={explorerBindings.openInTerminal}
                    onCopyPath={explorerBindings.copyPath}
                    canPaste={fileClipboardCanPaste}
                    pendingClipboardCollision={fileClipboardPendingCollision}
                    onClipboardCut={explorerBindings.cutClipboardItems}
                    onClipboardCopy={explorerBindings.copyClipboardItems}
                    onClipboardPaste={explorerBindings.pasteClipboardItems}
                    onClipboardResolveCollision={explorerBindings.resolveClipboardCollision}
                    onClipboardCancelCollision={explorerBindings.cancelClipboardCollision}
                    resolveExternalFilePath={explorerBindings.resolveExternalFilePath}
                    onExternalFilesDrop={explorerBindings.copyExternalFilesIntoTree}
                    onStartFileDrag={explorerBindings.startFileDrag}
                    onCompareFiles={explorerBindings.compareFiles}
                    sourceControlAvailable
                    onStagePath={sourceControlBindings.stagePath}
                    onDiscardPath={sourceControlBindings.discardPath}
                    onViewDiff={sourceControlBindings.viewDiff}
                  />
                }
                search={
                  <SearchPanel
                    activeWorkspace={activeWorkspace ?? null}
                    searchStore={searchStore}
                    onOpenResult={appCommands.openSearchResult}
                  />
                }
                sourceControl={
                  <SourceControlPanel
                    activeWorkspace={activeWorkspace ?? null}
                    sourceControlStore={sourceControlStore}
                    onOpenDiffTab={sourceControlBindings.openDiffTab}
                  />
                }
                tool={
                  <ToolFeedPanel
                    entries={activeToolFeedEntries}
                    activeWorkspaceName={activeWorkspace?.displayName ?? null}
                  />
                }
                session={
                  <SessionHistoryPanel
                    sessionRef={activeSessionRef}
                    activeWorkspaceName={activeWorkspace?.displayName ?? null}
                    readTranscript={window.nexusClaudeSession.readTranscript}
                  />
                }
              />
            </div>

            <PanelResizeHandle
              orientation="vertical"
              dragging={resizeBindings.draggingPanel === "sideBar"}
              aria-valuemin={resizeBindings.sideBar.minSize}
              aria-valuemax={resizeBindings.sideBar.maxSize}
              aria-valuenow={Math.round(resizeBindings.sideBar.size)}
              aria-label="Resize side bar"
              onKeyDown={resizeBindings.sideBar.onKeyDown}
              onPointerDown={resizeBindings.sideBar.onPointerDown}
            />
          </>
        )}

        <div className="min-h-0 min-w-0 flex-1">
          <CenterWorkbench
            bottomPanelPosition={bottomPanelPosition}
            bottomPanelExpanded={bottomPanelExpanded}
            bottomPanelSize={bottomPanelHeight}
            editorMaximized={editorWorkspaceService.getState().centerMode === "editor-max"}
            activeArea={appCommands.activeCenterArea}
            onActiveAreaChange={appCommands.setActiveCenterArea}
            onBottomPanelSizeChange={appCommands.setBottomPanelSize}
            editorArea={
              <EditorGroupsPart
                activeGroupId={editorBindings.activeGroupId}
                groups={editorBindings.groups}
                layoutSnapshot={editorBindings.layoutSnapshot}
                model={editorBindings.model}
                activeWorkspaceId={activeWorkspace?.id ?? null}
                activeWorkspaceName={activeWorkspace?.displayName ?? null}
                panes={editorBindings.panes}
                activePaneId={editorBindings.activePaneId}
                onActivatePane={editorBindings.activatePane}
                onSplitRight={editorBindings.splitRight}
                onReorderTab={editorBindings.reorderTab}
                onMoveTabToPane={editorBindings.moveTabToPane}
                onSplitTabRight={editorBindings.splitTabRight}
                onOpenFileFromTreeDrop={editorBindings.openFileFromTreeDrop}
                onActivateTab={editorBindings.activateTab}
                onCloseTab={editorBindings.closeTab}
                onCloseOtherTabs={editorBindings.closeOtherTabs}
                onCloseTabsToRight={editorBindings.closeTabsToRight}
                onCloseAllTabs={editorBindings.closeAllTabs}
                onCopyTabPath={editorBindings.copyTabPath}
                onRevealTabInFinder={editorBindings.revealTabInFinder}
                onTearOffTabToFloating={editorBindings.tearOffTabToFloating}
                onSaveTab={editorBindings.saveTab}
                onChangeContent={editorBindings.updateTabContent}
                onApplyWorkspaceEdit={editorBindings.applyWorkspaceEdit}
              />
            }
            bottomPanel={
              <BottomPanelPart
                sidebarState={sidebarState}
                active={appCommands.activeCenterArea === "bottom-panel"}
                views={bottomPanelViews}
                activeViewId={activeBottomPanelViewId}
                position={bottomPanelPosition}
                expanded={bottomPanelExpanded}
                onActiveViewChange={appCommands.activateBottomPanelView}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

async function runSidebarMutation(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error("Workspace sidebar: failed to apply workspace mutation.", error);
  }
}
