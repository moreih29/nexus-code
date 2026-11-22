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
  // Picked one by one: the whole store would render the app, every
  // workspace's tabs below it, for each connection status and progress.
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const [restoringWorkbench, setRestoringWorkbench] = useState(true);
  const settingsOpen = useSettingsUIStore((s) => s.settingsOpen);
  const settingsInitialActiveId = useSettingsUIStore((s) => s.initialActiveId);
  const closeSettings = useSettingsUIStore((s) => s.closeSettings);
  // Left-column visibility flags. Conditional render (not display:none)
  // so the ResizeHandle children inside Sidebar/FilesPanel don't leak
  // pointer events while hidden, and so width state stays in the store
  // ready to restore on re-show.
  const sidebarHidden = useUIStore((s) => s.sidebarHidden);
  const filesPanelHidden = useUIStore((s) => s.filesPanelHidden);
  // The agent view takes the place of the workspaces: its list for the
  // sidebar and the files, its panels for the workspace's.
  const agentView = useAgentViewStore((s) => s.mode === "agents");
  const peers = usePeerWorkbench(!sidebarHidden, !agentView);
  const activePeer = peers.active;
  const peerNeedsUpdate = peers.reachable && !peers.filesSupported;
  const peerGitNeedsUpdate = peers.reachable && !peers.gitSupported;
  const foldedPeers = useWorkspaceSidebarFolds((s) => s.foldedPeers);
  const togglePeerFold = useWorkspaceSidebarFolds((s) => s.togglePeer);

  // Workspaces that have been activated at least once in this session, and
  // tasks nexus started behind the user's view. Their <WorkspacePanel> stays
  // mounted (CSS-hidden when inactive) so PTYs survive workspace switches.
  // Pruned when the workspace itself disappears.
  const mountedIds = useMountedWorkspacesStore((s) => s.ids);
  // Add Workspace dialog state lives in a dedicated store so the
  // `workspace.add` keyboard command (⌘⇧N) can open it without prop drilling.
  const addWorkspaceOpen = useAddWorkspaceUIStore((s) => s.addWorkspaceOpen);
  const openAddWorkspace = useAddWorkspaceUIStore((s) => s.openAddWorkspace);
  const closeAddWorkspace = useAddWorkspaceUIStore((s) => s.closeAddWorkspace);

  useEffect(() => {
    if (!monaco) return;
    initializeEditorServices(monaco);
  }, [monaco]);

  // The workspace list arrives before the restored selection. Wait for both
  // before showing a welcome screen.
  useEffect(() => {
    void bootstrapWorkbench()
      // Tabs a usage limit stopped go on once it resets, restored ones too.
      .then(() => startLimitResume())
      .finally(() => setRestoringWorkbench(false));
    void bootstrapClaudeStatus();
  }, []);

  // Mark the active workspace as mounted (one-way; lazy-mount + persist).
  useEffect(() => {
    if (!activeWorkspaceId) return;
    useMountedWorkspacesStore.getState().mount(activeWorkspaceId);
  }, [activeWorkspaceId]);

  // Eager LSP rehydrate on workspace activation. The main-side host
  // caps concurrent live LSP servers (LSP_MAX_ACTIVE_WORKSPACES) and
  // evicts the LRU one when a third workspace's first file opens; the
  // evicted workspace's model entries then sit with `lspOpened: false`
  // until something pokes them. Calling `rehydrateLspForWorkspace`
  // here means "switching back into a workspace immediately re-issues
  // didOpen for its open files," so hover/completion start working
  // before the user even types. The function is a no-op for entries
  // that are already opened, so it's safe to fire on every activation.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    rehydrateLspForWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId]);

  // Prune mounted set when a workspace disappears. Tab-record cleanup
  // (closeAllForWorkspace / close wrappers) kills PTYs; panel unmount only
  // disposes view/controller instances.
  useEffect(() => {
    useMountedWorkspacesStore.getState().keepOnly(new Set(workspaces.map((w) => w.id)));
  }, [workspaces]);

  // The parent of the active workspace while it is a task: where removing
  // the task leaves the user.
  const activeParentIdRef = useRef<string | null>(null);
  useEffect(() => {
    const active = workspaces.find((w) => w.id === activeWorkspaceId);
    if (active) activeParentIdRef.current = active.task?.parentId ?? null;
  }, [workspaces, activeWorkspaceId]);

  // When the active workspace disappears (deleted, etc.), fall back to its
  // parent for a task, else to the first workspace, or null.
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

  // Read from the stores when called, so it stays the same function across
  // switches and the sidebar's rows are not handed a new one each time.
  const handleSelectWorkspace = useCallback((id: string) => {
    // The sidebar row stands for the workspace and its tasks; clicking the
    // row the active task belongs to keeps that task.
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
    // Tab seeding is handled by <WorkspacePanel> on first mount.
  }, []);

  const handleCloseAddWorkspace = useCallback(() => {
    closeAddWorkspace();
  }, [closeAddWorkspace]);

  const handleRemoveWorkspace = useCallback(
    async (id: string) => {
      const target = workspaces.find((w) => w.id === id);
      const name = target?.name ?? "this workspace";
      // Its tasks go with it, unsaved edits included.
      const tasks = tasksOf(workspaces, id);
      const unsaved = [id, ...tasks.map((task) => task.id)].reduce(
        (sum, workspaceId) => sum + countUnsavedBuffers(workspaceId),
        0,
      );
      const confirmed = await showRemoveWorkspaceConfirm(name, unsaved, tasks.length);
      if (!confirmed) return;
      // tabs store subscribes to `workspace:removed` and clears its slice;
      // that tab-record cleanup kills PTYs before panel unmount disposes views.
      // Fire-and-forget: tabs store cleanup happens via workspace:removed broadcast from main.
      void ipcCallResult("workspace", "remove", { id }).then((result) => {
        if (!result.ok) log.warn(`workspace remove failed: ${result.message}`);
      });
    },
    [workspaces],
  );

  // Apply resolved theme to documentElement (data-theme attribute) and
  // dispatch "nexus:theme-changed" for Monaco / xterm sync.
  useThemeEffect();

  // Apply --window-opacity CSS property to documentElement.
  useWindowOpacityEffect();
  useInactivePanelDimEffect();

  // Wire the keyboard dispatcher and the Application Menu IPC bridge to
  // the same command registry. Both surfaces resolve to one
  // implementation per command.
  useGlobalKeybindings();
  useCommandBridge();

  // Render panels for every mounted workspace; only the active is visible.
  // Filter through `workspaces` so a deleted workspace's panel disappears
  // (its mounted-set entry is pruned by the effect above).
  const mountedWorkspaces = workspaces.filter((w) => mountedIds.has(w.id));

  // Root ErrorBoundary: catches React render/lifecycle errors anywhere in the
  // application tree and logs them via the facade. It does NOT catch async errors
  // from event handlers — those are covered by the window 'error' /
  // 'unhandledrejection' listeners in window-error-handler.ts.
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
          {/* Kept mounted once shown, hidden while the other view or the
              toggle hides them: switching views reveals them, folds and
              scroll as they were, instead of building them again. */}
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
                    gitUpdateNeeded={peerGitNeedsUpdate}
                    refreshGit={peers.refreshGit}
                    sessionHint={peers.sessionHint}
                  />
                ) : undefined
              }
            />
          </KeptMounted>
          {/* The panels, where quick look and the release notes show over them. */}
          <div
            className="relative grid grid-cols-1 grid-rows-1 flex-1 min-w-0 overflow-hidden"
            {...{ [LOOK_AREA_ATTR]: "" }}
          >
            {/* In the one cell, as the panels are: the agent view, kept
                mounted there, would push it into a row of its own below. */}
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
            {/* Kept mounted, as the workspaces are: a tab moves between its
                panels and the workspace's groups without leaving the
                document, which would lose its scroll and reload its frames. */}
            <AgentView shown={agentView} />
            <ReleaseNotesView />
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
