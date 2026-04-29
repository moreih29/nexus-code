import { useCallback, useMemo } from "react";

import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace/workspace-shell";
import { CenterWorkbench } from "../components/CenterWorkbench";
import { ClaudeSettingsConsentDialog } from "../components/ClaudeSettingsConsentDialog";
import { CommandPalette } from "../components/CommandPalette";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { SearchPanel } from "../components/SearchPanel";
import { SessionHistoryPanel } from "../components/SessionHistoryPanel";
import { SourceControlPanel } from "../components/SourceControlPanel";
import { ToolFeedPanel } from "../components/ToolFeedPanel";
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
import { FileTreePanelContainer } from "./FileTreePanelContainer";
import { useAppShellBindings } from "./hooks/useAppShellBindings";
import { useAppShellState } from "./hooks/useAppShellState";
import { useClaudeConsentDialog } from "./hooks/useClaudeConsentDialog";
import { useAppServices } from "./wiring";

export { closeActiveEditorTabOrWorkspace, registerAppCommands } from "./commands";
export { unifiedDiffToSideContents } from "./useSourceControlBindings";

export default function App(): JSX.Element {
  const services = useAppServices();
  const {
    bottomPanel: bottomPanelStore,
    search: searchStore,
    sourceControl: sourceControlStore,
    editorGroups: editorGroupsService,
    editorWorkspace: editorWorkspaceService,
    terminal: terminalService,
  } = services;
  const appShellState = useAppShellState(services);
  const {
    sidebarState,
    activeWorkspace,
    activityBarViews,
    activeActivityBarViewId,
    sideBarCollapsed,
    activeSideBarRoute,
    bottomPanelViews,
    activeBottomPanelViewId,
    bottomPanelPosition,
    bottomPanelExpanded,
    bottomPanelHeight,
    detachedBottomPanelTerminalIds,
    badgeByWorkspaceId,
    activeToolFeedEntries,
    activeSessionRef,
    editorCenterMode,
    terminalTabs,
  } = appShellState;
  const appShellBindings = useAppShellBindings({
    services,
    activeWorkspace,
    openWorkspaces: sidebarState.openWorkspaces,
  });
  const {
    editorBindings,
    appCommands,
    sourceControlBindings,
    resizeBindings,
  } = appShellBindings;
  const claudeConsentDialog = useClaudeConsentDialog();

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
                  <FileTreePanelContainer
                    appState={appShellState}
                    bindings={appShellBindings}
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
            editorMaximized={editorCenterMode === "editor-max"}
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
        open={claudeConsentDialog.request !== null}
        workspaceName={claudeConsentDialog.request?.workspaceName ?? "this workspace"}
        harnessName={claudeConsentDialog.request?.harnessName}
        settingsFiles={claudeConsentDialog.request?.settingsFiles}
        settingsDescription={claudeConsentDialog.request?.settingsDescription}
        gitignoreEntries={claudeConsentDialog.request?.gitignoreEntries}
        dontAskAgain={claudeConsentDialog.dontAskAgain.checked}
        onOpenChange={(open) => {
          if (!open) {
            claudeConsentDialog.dismiss();
          }
        }}
        onDontAskAgainChange={claudeConsentDialog.dontAskAgain.set}
        onApprove={(decision) => {
          claudeConsentDialog.complete(true, decision.dontAskAgain);
        }}
        onCancel={claudeConsentDialog.dismiss}
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
