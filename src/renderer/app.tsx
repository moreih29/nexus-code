import { useMonaco } from "@monaco-editor/react";
import { useCallback, useEffect, useRef } from "react";
import { createLogger } from "../shared/log/renderer";
import type { WorkspaceMeta } from "../shared/types/workspace";
import { bootstrapAppState, bootstrapClaudeStatus, bootstrapWorkspaces } from "./bootstrap";
import { useCommandBridge } from "./commands/use-command-bridge";
import { AgentSidebar } from "./components/agent-view/agent-sidebar";
import { AgentView } from "./components/agent-view/agent-view";
import { FilesPanel } from "./components/files";
import { GlobalRoots } from "./components/global-roots";
import { ManagerDock } from "./components/manager/manager-dock";
import { AboutPanel } from "./components/settings/panels/about-panel";
import { AgentPanel } from "./components/settings/panels/agent-panel";
import { AgentProfilesPanel } from "./components/settings/panels/agent-profiles-panel";
import { AppearancePanel } from "./components/settings/panels/appearance-panel";
import { BrowserPermissionsPanel } from "./components/settings/panels/browser-permissions-panel";
import { EditorPanel } from "./components/settings/panels/editor-panel";
import { KeybindingsPanel } from "./components/settings/panels/keybindings-panel";
import { LanguageServersPanel } from "./components/settings/panels/language-servers-panel";
import { ManagerPanel } from "./components/settings/panels/manager-panel";
import { NotificationsPanel } from "./components/settings/panels/notifications-panel";
import { ProfileRulesPanel } from "./components/settings/panels/profile-rules-panel";
import { RemotePanel } from "./components/settings/panels/remote-panel";
import { TerminalPanel } from "./components/settings/panels/terminal-panel";
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
import { LOOK_AREA_ATTR } from "./services/chat/look-area";
import { initializeEditorServices } from "./services/editor";
import { rehydrateLspForWorkspace } from "./services/editor/model/cache";
import { countUnsavedBuffers } from "./services/editor/save/unsaved-guard";
import { useActiveStore } from "./state/stores/active";
import { useAddWorkspaceUIStore } from "./state/stores/add-workspace-ui";
import { useAgentViewStore } from "./state/stores/agent-view";
import { useMountedWorkspacesStore } from "./state/stores/mounted-workspaces";
import { useSettingsUIStore } from "./state/stores/settings-ui";
import { useUIStore } from "./state/stores/ui";
import {
  rootWorkspaceId,
  tasksOf,
  useWorkspacesStore,
  visibleWorkspaces,
} from "./state/stores/workspaces";

const log = createLogger("app");

export function App() {
  const monaco = useMonaco();
  // Picked one by one: the whole store would render the app, every
  // workspace's tabs below it, for each connection status and progress.
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const setAll = useWorkspacesStore((s) => s.setAll);
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const setActiveWorkspaceId = useActiveStore((s) => s.setActiveWorkspaceId);
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

  // Boot: hydrate UI state (sidebar width, files panel) and layout/tabs from persisted app state.
  useEffect(() => {
    bootstrapAppState();
  }, []);

  // Boot: Claude 세션 상태 snapshot 로드 및 status broadcast 구독 설정.
  useEffect(() => {
    void bootstrapClaudeStatus();
  }, []);

  // Boot: load workspaces from main, activate first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: boot-once effect; store setters are stable
  useEffect(() => {
    bootstrapWorkspaces(setAll, setActiveWorkspaceId);
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
    if (activeWorkspaceId && !workspaces.some((w) => w.id === activeWorkspaceId)) {
      const parentId = activeParentIdRef.current;
      const next =
        (parentId !== null && workspaces.some((w) => w.id === parentId)
          ? parentId
          : visibleWorkspaces(workspaces)[0]?.id) ?? null;
      setActiveWorkspaceId(next);
      if (next) {
        // Fire-and-forget: UI is already updated; notify main of workspace switch.
        void ipcCallResult("workspace", "activate", { id: next }).then((result) => {
          if (!result.ok) log.warn(`workspace activate failed: ${result.message}`);
        });
      }
    }
  }, [workspaces, activeWorkspaceId, setActiveWorkspaceId]);

  // Read from the stores when called, so it stays the same function across
  // switches and the sidebar's rows are not handed a new one each time.
  const handleSelectWorkspace = useCallback(
    (id: string) => {
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
      setActiveWorkspaceId(id);
      // Fire-and-forget: UI is already updated; notify main of workspace switch.
      void ipcCallResult("workspace", "activate", { id }).then((result) => {
        if (!result.ok) log.warn(`workspace activate failed: ${result.message}`);
      });
    },
    [setActiveWorkspaceId],
  );

  const handleAddWorkspace = useCallback(() => {
    openAddWorkspace();
  }, [openAddWorkspace]);

  const handleWorkspaceCreated = useCallback(
    async (meta: WorkspaceMeta) => {
      useAgentViewStore.getState().setMode("workspace");
      setActiveWorkspaceId(meta.id);
      // Fire-and-forget: UI is already updated; notify main of new workspace activation.
      void ipcCallResult("workspace", "activate", { id: meta.id }).then((result) => {
        if (!result.ok) log.warn(`workspace activate failed: ${result.message}`);
      });
      // Tab seeding is handled by <WorkspacePanel> on first mount.
    },
    [setActiveWorkspaceId],
  );

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
        <TitleBar />
        <GlobalRoots />
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
          {(activeId, go) => {
            if (activeId === "appearance") return <AppearancePanel />;
            if (activeId === "editor") return <EditorPanel />;
            if (activeId === "language-servers") return <LanguageServersPanel />;
            if (activeId === "terminal") return <TerminalPanel />;
            if (activeId === "notifications") return <NotificationsPanel />;
            if (activeId === "agent") return <AgentPanel />;
            if (activeId === "claude") return <AgentProfilesPanel agent="claude" onNavigate={go} />;
            if (activeId === "codex") return <AgentProfilesPanel agent="codex" onNavigate={go} />;
            if (activeId === "profile-rules") return <ProfileRulesPanel />;
            if (activeId === "manager") return <ManagerPanel />;
            if (activeId === "remote") return <RemotePanel />;
            if (activeId === "browser-permissions") return <BrowserPermissionsPanel />;
            if (activeId === "keybindings") return <KeybindingsPanel />;
            if (activeId === "about") return <AboutPanel />;
            return null;
          }}
        </SettingsDialog>
        <div className="flex flex-1 min-h-0 overflow-hidden gap-[6px] p-[6px]">
          {/* Kept mounted once shown, hidden while the other view or the
              toggle hides them: switching views reveals them, folds and
              scroll as they were, instead of building them again. */}
          <KeptMounted shown={!sidebarHidden && agentView}>
            <AgentSidebar />
          </KeptMounted>
          <KeptMounted shown={!sidebarHidden && !agentView}>
            <Sidebar
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              onSelectWorkspace={handleSelectWorkspace}
              onAddWorkspace={handleAddWorkspace}
              onRemoveWorkspace={handleRemoveWorkspace}
            />
          </KeptMounted>
          <KeptMounted shown={!filesPanelHidden && !agentView}>
            <FilesPanel />
          </KeptMounted>
          {/* The panels, where quick look and the release notes show over them. */}
          <div
            className="relative grid grid-cols-1 grid-rows-1 flex-1 min-w-0 overflow-hidden"
            {...{ [LOOK_AREA_ATTR]: "" }}
          >
            {workspaces.length === 0 && !agentView && (
              <div className="flex flex-col island-surface rounded-(--radius-island) overflow-hidden">
                <WelcomeScreen onAddWorkspace={handleAddWorkspace} />
              </div>
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
          <ManagerDock />
        </div>
      </div>
    </ErrorBoundary>
  );
}
