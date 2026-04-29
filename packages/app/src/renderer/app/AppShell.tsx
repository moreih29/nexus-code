import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import type { ClaudeSettingsConsentRequest } from "../../../../shared/src/contracts/claude/claude-settings";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace/workspace-shell";
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
import { StatusBarPart, type StatusBarActiveItem } from "../parts/status-bar";
import { TitleBarPart } from "../parts/titlebar";
import { WorkspaceStripPart } from "../parts/workspace-strip";
import type { DropExternalEditorPayloadInput, EditorGroup, EditorGroupId } from "../services/editor-groups-service";
import type { EditorPaneState, EditorTab } from "../services/editor-types";
import type { TerminalTab } from "../services/terminal-service";
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
    terminal: terminalService,
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
  const detachedBottomPanelTerminalIds = useStore(bottomPanelStore, (state) => state.detachedTerminalIds);
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
  const terminalTabs = useStore(terminalService, (state) => state.tabs);
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
    openWorkspaces: sidebarState.openWorkspaces,
    workspaceService: editorWorkspaceService,
  });
  const appCommands = useAppCommands({
    activityBarStore,
    bottomPanelStore,
    editorBindings,
    editorGroupsService,
    editorWorkspaceService,
    searchStore,
    terminalService,
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
  const handleEditorDropExternalPayload = useCallback((input: DropExternalEditorPayloadInput): void => {
    if (input.payload.type !== "terminal-tab") {
      editorBindings.dropExternalPayload(input);
      return;
    }

    const droppedGroupId = editorGroupsService.getState().dropExternalPayload(input);
    if (!droppedGroupId) {
      return;
    }

    bottomPanelStore.getState().detachTerminalFromBottom(input.payload.tabId);
    terminalService.getState().setActiveTab(input.payload.tabId);
    editorWorkspaceService.getState().setCenterMode("editor-max");
    appCommands.setActiveCenterArea("editor");
    window.setTimeout(() => {
      terminalService.getState().focusSession(input.payload.tabId);
    }, 0);
  }, [
    appCommands,
    bottomPanelStore,
    editorBindings,
    editorGroupsService,
    editorWorkspaceService,
    terminalService,
  ]);
  const statusBarActiveItem = useMemo(() => resolveStatusBarActiveItem({
    activeGroupId: editorBindings.activeGroupId,
    groups: editorBindings.groups,
    panes: editorBindings.panes,
    terminalTabs,
    workspaces: sidebarState.openWorkspaces,
  }), [
    editorBindings.activeGroupId,
    editorBindings.groups,
    editorBindings.panes,
    sidebarState.openWorkspaces,
    terminalTabs,
  ]);

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
    <div className="flex h-full flex-col bg-background text-foreground">
      <TitleBarPart
        hasWorkspace={Boolean(activeWorkspace)}
        platform={globalThis.window?.nexusEnvironment?.platform ?? "linux"}
        onOpenCommandPalette={() => appCommands.setCommandPaletteOpen(true)}
        onOpenWorkspace={() => void runSidebarMutation(appCommands.openFolder)}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
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
            onActivateWorkspace={(workspaceId) => runSidebarMutation(() => appCommands.activateWorkspace(workspaceId))}
            onCloseWorkspace={(workspaceId) => runSidebarMutation(() => appCommands.closeWorkspace(workspaceId))}
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
                editorGroupsService={editorGroupsService}
                terminalService={terminalService}
                layoutSnapshot={editorBindings.layoutSnapshot}
                model={editorBindings.model}
                activeWorkspaceId={activeWorkspace?.id ?? null}
                activeWorkspaceName={activeWorkspace?.displayName ?? null}
                panes={editorBindings.panes}
                activePaneId={editorBindings.activePaneId}
                onActivatePane={editorBindings.activatePane}
                onSplitRight={editorBindings.splitRight}
                onSplitTabRight={editorBindings.splitTabRight}
                onCloseTab={editorBindings.closeTab}
                onCopyTabPath={editorBindings.copyTabPath}
                onRevealTabInFinder={editorBindings.revealTabInFinder}
                onSaveTab={editorBindings.saveTab}
                onChangeContent={editorBindings.updateTabContent}
                onApplyWorkspaceEdit={editorBindings.applyWorkspaceEdit}
                onDropExternalPayload={handleEditorDropExternalPayload}
                onMoveTerminalToBottomPanel={appCommands.moveTerminalToBottomPanel}
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
                terminalService={terminalService}
                detachedTerminalIds={detachedBottomPanelTerminalIds}
                onMoveTerminalToEditorArea={appCommands.moveTerminalToEditorArea}
                onDropTerminalTab={(payload) => {
                  appCommands.moveTerminalToBottomPanel(payload.tabId);
                  return true;
                }}
              />
            }
          />
        </div>
      </div>
      <StatusBarPart activeItem={statusBarActiveItem} />
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

function resolveStatusBarActiveItem({
  activeGroupId,
  groups,
  panes,
  terminalTabs,
  workspaces,
}: {
  activeGroupId: EditorGroupId | null;
  groups: readonly EditorGroup[];
  panes: readonly EditorPaneState[];
  terminalTabs: readonly TerminalTab[];
  workspaces: readonly OpenSessionWorkspace[];
}): StatusBarActiveItem {
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null;
  const activeGroupTab = activeGroup?.tabs.find((tab) => tab.id === activeGroup.activeTabId) ?? null;

  if (!activeGroupTab) {
    return { kind: "empty" };
  }

  if (activeGroupTab.kind === "file") {
    const activeEditorTab = findEditorTab(panes, activeGroupTab.id);
    return activeEditorTab
      ? {
          kind: "file",
          lspStatus: activeEditorTab.lspStatus,
          diagnostics: activeEditorTab.diagnostics,
          language: activeEditorTab.language ?? activeEditorTab.monacoLanguage,
        }
      : {
          kind: "file",
          lspStatus: null,
          diagnostics: [],
          language: null,
        };
  }

  if (activeGroupTab.kind === "terminal") {
    const terminalTab = terminalTabs.find((tab) => tab.id === activeGroupTab.id) ?? null;
    const workspace = workspaces.find((candidate) => candidate.id === activeGroupTab.workspaceId) ?? null;
    return {
      kind: "terminal",
      shell: terminalTab?.shell ?? null,
      cwd: terminalTab?.cwd ?? workspace?.absolutePath ?? null,
      pid: terminalTab?.pid ?? null,
    };
  }

  return {
    kind: activeGroupTab.kind === "diff" ? "diff" : "preview",
    label: activeGroupTab.title,
  };
}

function findEditorTab(panes: readonly EditorPaneState[], tabId: string): EditorTab | null {
  for (const pane of panes) {
    const tab = pane.tabs.find((candidate) => candidate.id === tabId);
    if (tab) {
      return tab;
    }
  }

  return null;
}
