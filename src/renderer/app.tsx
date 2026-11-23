import { useMonaco } from "@monaco-editor/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../shared/log/renderer";
import type { WorkspaceMeta } from "../shared/types/workspace";
import { bootstrapClaudeStatus, bootstrapWorkbench } from "./bootstrap";
import { useCommandBridge } from "./commands/use-command-bridge";
import { AgentSidebar } from "./components/agent-view/agent-sidebar";
import { AgentView } from "./components/agent-view/agent-view";
import { FilesPanel } from "./components/files";
import { GlobalRoots } from "./components/global-roots";
import { PeerFilesPanel } from "./components/peer-workspace/files-panel";
import { PeerWorkspacePanel } from "./components/peer-workspace/panel";
import { PeerQuickOpen } from "./components/peer-workspace/quick-open";
import { usePeerWorkbench } from "./components/peer-workspace/room";
import { PeerWorkspaceSection } from "./components/peer-workspace/sidebar";
import { PeerWorkspaceTitle } from "./components/peer-workspace/title";
import { SettingsDialog } from "./components/settings/settings-dialog";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { KeptMounted } from "./components/ui/kept-mounted";
import { ReleaseNotesView } from "./components/workbench/release-notes";
import { Sidebar } from "./components/workbench/sidebar";
import { TitleBar } from "./components/workbench/title-bar";
import { WelcomeScreen } from "./components/workbench/welcome-screen";
import { AddWorkspaceDialog } from "./components/workspace/add-workspace";
import { WorkspacePanel } from "./components/workspace/panel";
import { showRemoveWorkspaceConfirm } from "./components/workspace/remove-workspace-dialog";
import { useInactivePanelDimEffect } from "./hooks/use-inactive-panel-dim-effect";
import { useThemeEffect } from "./hooks/use-theme-effect";
import { useWindowOpacityEffect } from "./hooks/use-window-opacity-effect";
import { ipcCallResult } from "./ipc/client";
import { useGlobalKeybindings } from "./keybindings/use-global-keybindings";
import { startLimitResume } from "./services/chat/limit-resume-scheduler";
import { LOOK_AREA_ATTR } from "./services/chat/look-area";
import { initializeEditorServices } from "./services/editor";
import { rehydrateLspForWorkspace } from "./services/editor/model/cache";
import { countUnsavedBuffers } from "./services/editor/save/unsaved-guard";
import { activateWorkspace, focusWorkspace } from "./state/operations/workspace-selection";
import { useActiveStore } from "./state/stores/active";
import { useAddWorkspaceUIStore } from "./state/stores/add-workspace-ui";
import { useAgentViewStore } from "./state/stores/agent-view";
import { useMountedWorkspacesStore } from "./state/stores/mounted-workspaces";
import { peerTargetId } from "./state/stores/peer-workspace";
import { useSettingsUIStore } from "./state/stores/settings-ui";
import { useUIStore } from "./state/stores/ui";
import { useWorkspaceSidebarFolds } from "./state/stores/workspace-sidebar-folds";
import {
  rootWorkspaceId,
  tasksOf,
  useWorkspacesStore,
  visibleWorkspaces,
} from "./state/stores/workspaces";

const log = createLogger("app");

const SettingsPanels = lazy(() =>
  import("./components/settings/settings-panels").then(({ SettingsPanels }) => ({
    default: SettingsPanels,
  })),
);

export function App() {
  const monaco = useMonaco();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const [restoringWorkbench, setRestoringWorkbench] = useState(true);
  const settingsOpen = useSettingsUIStore((s) => s.settingsOpen);
  const settingsInitialActiveId = useSettingsUIStore((s) => s.initialActiveId);
  const closeSettings = useSettingsUIStore((s) => s.closeSettings);
  const sidebarHidden = useUIStore((s) => s.sidebarHidden);
  const filesPanelHidden = useUIStore((s) => s.filesPanelHidden);
  const agentView = useAgentViewStore((s) => s.mode === "agents");
  const peers = usePeerWorkbench(!sidebarHidden, !agentView);
  const activePeer = peers.active;
  const peerListing =
    activePeer && Object.hasOwn(peers.lists, activePeer.deviceId)
      ? peers.lists[activePeer.deviceId]
      : undefined;
  const peerNeedsUpdate = peers.reachable && !peers.filesSupported;
  const peerGitNeedsUpdate = peers.reachable && !peers.gitSupported;
  const foldedPeers = useWorkspaceSidebarFolds((s) => s.foldedPeers);
  const togglePeerFold = useWorkspaceSidebarFolds((s) => s.togglePeer);

  const mountedIds = useMountedWorkspacesStore((s) => s.ids);
  const addWorkspaceOpen = useAddWorkspaceUIStore((s) => s.addWorkspaceOpen);
  const openAddWorkspace = useAddWorkspaceUIStore((s) => s.openAddWorkspace);
  const closeAddWorkspace = useAddWorkspaceUIStore((s) => s.closeAddWorkspace);

  useEffect(() => {
    if (!monaco) return;
    initializeEditorServices(monaco);
  }, [monaco]);

  useEffect(() => {
    void bootstrapWorkbench()
      .then(() => startLimitResume())
      .finally(() => setRestoringWorkbench(false));
    void bootstrapClaudeStatus();
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    useMountedWorkspacesStore.getState().mount(activeWorkspaceId);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    rehydrateLspForWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId]);

  useEffect(() => {
    useMountedWorkspacesStore.getState().keepOnly(new Set(workspaces.map((w) => w.id)));
  }, [workspaces]);

  const activeParentIdRef = useRef<string | null>(null);
  useEffect(() => {
    const active = workspaces.find((w) => w.id === activeWorkspaceId);
    if (active) activeParentIdRef.current = active.task?.parentId ?? null;
  }, [workspaces, activeWorkspaceId]);

  useEffect(() => {
    if (useActiveStore.getState().activeWorkspaceId !== activeWorkspaceId) return;
    if (activeWorkspaceId && !workspaces.some((w) => w.id === activeWorkspaceId)) {
      const parentId = activeParentIdRef.current;
      const next =
        (parentId !== null && workspaces.some((w) => w.id === parentId)
          ? parentId
          : visibleWorkspaces(workspaces)[0]?.id) ?? null;
      if (next) activateWorkspace(next, "preserve");
      else focusWorkspace(null, "preserve");
    }
  }, [workspaces, activeWorkspaceId]);

  const handleSelectWorkspace = useCallback((id: string) => {
    const activeWorkspaceId = useActiveStore.getState().activeWorkspaceId;
    const workspaces = useWorkspacesStore.getState().workspaces;
    if (
      activeWorkspaceId !== null &&
      activeWorkspaceId !== id &&
      rootWorkspaceId(workspaces, activeWorkspaceId) === id
    ) {
      return;
    }
    activateWorkspace(id, "preserve");
  }, []);

  const handleAddWorkspace = useCallback(() => {
    openAddWorkspace();
  }, [openAddWorkspace]);

  const handleWorkspaceCreated = useCallback(async (meta: WorkspaceMeta) => {
    activateWorkspace(meta.id);
  }, []);

  const handleCloseAddWorkspace = useCallback(() => {
    closeAddWorkspace();
  }, [closeAddWorkspace]);

  const handleRemoveWorkspace = useCallback(
    async (id: string) => {
      const target = workspaces.find((w) => w.id === id);
      const name = target?.name ?? "this workspace";
      const tasks = tasksOf(workspaces, id);
      const unsaved = [id, ...tasks.map((task) => task.id)].reduce(
        (sum, workspaceId) => sum + countUnsavedBuffers(workspaceId),
        0,
      );
      const confirmed = await showRemoveWorkspaceConfirm(name, unsaved, tasks.length);
      if (!confirmed) return;
      void ipcCallResult("workspace", "remove", { id }).then((result) => {
        if (!result.ok) log.warn(`workspace remove failed: ${result.message}`);
      });
    },
    [workspaces],
  );

  useThemeEffect();

  useWindowOpacityEffect();
  useInactivePanelDimEffect();

  useGlobalKeybindings();
  useCommandBridge();

  const mountedWorkspaces = workspaces.filter((w) => mountedIds.has(w.id));

  return (
    <ErrorBoundary logSource="renderer">
      <div className="flex flex-col h-full overflow-hidden backdrop-surface">
        <TitleBar
          peerTitle={
            activePeer
              ? (maxWidth) => (
                  <PeerWorkspaceTitle
                    target={activePeer}
                    workspaces={peers.workspaces}
                    sessions={
                      peerListing?.status === "ready" ? peerListing.list.sessions : undefined
                    }
                    canSelectTask={peers.reachable && !peers.missing}
                    maxWidth={maxWidth}
                  />
                )
              : undefined
          }
        />
        <GlobalRoots />
        {activePeer && !agentView && (
          <PeerQuickOpen
            key={peerTargetId(activePeer)}
            target={activePeer}
            reach={peers.reach}
            canRead={peers.reachable && peers.filesSupported}
            missing={peers.missing}
            updateNeeded={peerNeedsUpdate}
          />
        )}
        <AddWorkspaceDialog
          open={addWorkspaceOpen}
          onClose={handleCloseAddWorkspace}
          onWorkspaceCreated={handleWorkspaceCreated}
        />
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            if (!open) closeSettings();
          }}
          defaultActiveId={settingsInitialActiveId}
        >
          {(activeId, go) => (
            <Suspense fallback={null}>
              <SettingsPanels activeId={activeId} go={go} />
            </Suspense>
          )}
        </SettingsDialog>
        <div className="flex flex-1 min-h-0 overflow-hidden gap-[6px] p-[6px]">
          <KeptMounted shown={!sidebarHidden && agentView}>
            <AgentSidebar shown={!sidebarHidden && agentView} />
          </KeptMounted>
          <KeptMounted shown={!sidebarHidden && !agentView}>
            <Sidebar
              workspaces={workspaces}
              peerSection={
                peers.accountKey && (peers.online.length > 0 || peers.offline.length > 0) ? (
                  <PeerWorkspaceSection
                    accountKey={peers.accountKey}
                    online={peers.online}
                    offline={peers.offline}
                    lists={peers.lists}
                    active={peers.active}
                    missing={peers.missing}
                    folded={foldedPeers}
                    toggleFold={togglePeerFold}
                  />
                ) : undefined
              }
              activeWorkspaceId={activeWorkspaceId}
              onSelectWorkspace={handleSelectWorkspace}
              onAddWorkspace={handleAddWorkspace}
              onRemoveWorkspace={handleRemoveWorkspace}
            />
          </KeptMounted>
          <KeptMounted shown={!filesPanelHidden && !agentView}>
            <FilesPanel
              peerPanel={
                activePeer ? (
                  <PeerFilesPanel
                    key={JSON.stringify([
                      activePeer.accountKey,
                      peerTargetId(activePeer),
                      activePeer.workspace.path,
                    ])}
                    target={activePeer}
                    peer={peers.peer}
                    missing={peers.missing}
                    canRead={
                      !agentView && !filesPanelHidden && peers.reachable && peers.filesSupported
                    }
                    updateNeeded={peerNeedsUpdate}
                    rejoin={peers.rejoin}
                    canReadGit={
                      !agentView && !filesPanelHidden && peers.reachable && peers.gitSupported
                    }
                    canReadNotes={
                      !agentView && !filesPanelHidden && peers.reachable && peers.notesSupported
                    }
                    gitUpdateNeeded={peerGitNeedsUpdate}
                    refreshGit={peers.refreshGit}
                    sessionHint={peers.sessionHint}
                    listing={peerListing}
                  />
                ) : undefined
              }
            />
          </KeptMounted>
          <div
            className="relative grid grid-cols-1 grid-rows-1 flex-1 min-w-0 overflow-hidden"
            {...{ [LOOK_AREA_ATTR]: "" }}
          >
            {!restoringWorkbench && activeWorkspaceId === null && !activePeer && !agentView && (
              <div className="col-start-1 row-start-1 flex flex-col island-surface rounded-(--radius-island) overflow-hidden">
                <WelcomeScreen
                  onAddWorkspace={workspaces.length === 0 ? handleAddWorkspace : undefined}
                />
              </div>
            )}
            {activePeer && (
              <PeerWorkspacePanel
                key={JSON.stringify([activePeer.accountKey, peerTargetId(activePeer)])}
                target={activePeer}
                peer={peers.peer}
                shown={!agentView}
                reach={peers.reach}
                reachable={peers.reachable}
                missing={peers.missing}
                updateNeeded={peerNeedsUpdate}
                gitUpdateNeeded={peerGitNeedsUpdate}
                rejoin={peers.rejoin}
              />
            )}
            {mountedWorkspaces.map((ws) => (
              <WorkspacePanel
                key={ws.id}
                workspace={ws}
                isActive={!agentView && ws.id === activeWorkspaceId}
              />
            ))}
            <AgentView shown={agentView} />
            <ReleaseNotesView />
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
