import { useMonaco } from "@monaco-editor/react";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceMeta } from "../shared/types/workspace";
import { bootstrapAppState, bootstrapWorkspaces } from "./bootstrap";
import { useCommandBridge } from "./commands/use-command-bridge";
import { FilesPanel } from "./components/files";
import { GlobalRoots } from "./components/global-roots";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { showRemoveWorkspaceConfirm } from "./components/workspace/remove-workspace-dialog";
import { Sidebar } from "./components/workbench/sidebar";
import { TitleBar } from "./components/workbench/title-bar";
import { WelcomeScreen } from "./components/workbench/welcome-screen";
import { AddWorkspaceDialog } from "./components/workspace/add-workspace";
import { WorkspacePanel } from "./components/workspace/panel";
import { useThemeEffect } from "./hooks/use-theme-effect";
import { useWindowOpacityEffect } from "./hooks/use-window-opacity-effect";
import { ipcCallResult } from "./ipc/client";
import { useGlobalKeybindings } from "./keybindings/use-global-keybindings";
import { initializeEditorServices } from "./services/editor";
import { useActiveStore } from "./state/stores/active";
import { useWorkspacesStore } from "./state/stores/workspaces";

export function App() {
  const monaco = useMonaco();
  const { workspaces, setAll } = useWorkspacesStore();
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveStore();

  // Workspaces that have been activated at least once in this session.
  // Their <WorkspacePanel> stays mounted (CSS-hidden when inactive) so PTYs
  // survive workspace switches. Pruned when the workspace itself disappears.
  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set());
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);

  useEffect(() => {
    if (!monaco) return;
    initializeEditorServices(monaco);
  }, [monaco]);

  // Boot: hydrate UI state (sidebar width, files panel) and layout/tabs from persisted app state.
  useEffect(() => {
    bootstrapAppState();
  }, []);

  // Boot: load workspaces from main, activate first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: boot-once effect; store setters are stable
  useEffect(() => {
    bootstrapWorkspaces(setAll, setActiveWorkspaceId);
  }, []);

  // Mark the active workspace as mounted (one-way; lazy-mount + persist).
  useEffect(() => {
    if (!activeWorkspaceId) return;
    setMountedIds((prev) => {
      if (prev.has(activeWorkspaceId)) return prev;
      const next = new Set(prev);
      next.add(activeWorkspaceId);
      return next;
    });
  }, [activeWorkspaceId]);

  // Prune mounted set when a workspace disappears. Tab-record cleanup
  // (closeAllForWorkspace / close wrappers) kills PTYs; panel unmount only
  // disposes view/controller instances.
  useEffect(() => {
    setMountedIds((prev) => {
      const alive = new Set(workspaces.map((w) => w.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (alive.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [workspaces]);

  // When the active workspace disappears (deleted, etc.), fall back to the next one or null.
  useEffect(() => {
    if (activeWorkspaceId && !workspaces.some((w) => w.id === activeWorkspaceId)) {
      const next = workspaces[0]?.id ?? null;
      setActiveWorkspaceId(next);
      if (next) {
        // Fire-and-forget: UI is already updated; notify main of workspace switch.
        void ipcCallResult("workspace", "activate", { id: next }).then((result) => {
          if (!result.ok) console.warn("[app] workspace activate failed", result.message);
        });
      }
    }
  }, [workspaces, activeWorkspaceId, setActiveWorkspaceId]);

  const handleSelectWorkspace = useCallback(
    (id: string) => {
      setActiveWorkspaceId(id);
      // Fire-and-forget: UI is already updated; notify main of workspace switch.
      void ipcCallResult("workspace", "activate", { id }).then((result) => {
        if (!result.ok) console.warn("[app] workspace activate failed", result.message);
      });
    },
    [setActiveWorkspaceId],
  );

  const handleAddWorkspace = useCallback(() => {
    setAddWorkspaceOpen(true);
  }, []);

  const handleWorkspaceCreated = useCallback(
    async (meta: WorkspaceMeta) => {
      setActiveWorkspaceId(meta.id);
      // Fire-and-forget: UI is already updated; notify main of new workspace activation.
      void ipcCallResult("workspace", "activate", { id: meta.id }).then((result) => {
        if (!result.ok) console.warn("[app] workspace activate failed", result.message);
      });
      // Tab seeding is handled by <WorkspacePanel> on first mount.
    },
    [setActiveWorkspaceId],
  );

  const handleCloseAddWorkspace = useCallback(() => {
    setAddWorkspaceOpen(false);
  }, []);

  const handleRemoveWorkspace = useCallback(
    async (id: string) => {
      const target = workspaces.find((w) => w.id === id);
      const name = target?.name ?? "this workspace";
      const confirmed = await showRemoveWorkspaceConfirm(name);
      if (!confirmed) return;
      // tabs store subscribes to `workspace:removed` and clears its slice;
      // that tab-record cleanup kills PTYs before panel unmount disposes views.
      // Fire-and-forget: tabs store cleanup happens via workspace:removed broadcast from main.
      void ipcCallResult("workspace", "remove", { id }).then((result) => {
        if (!result.ok) console.warn("[app] workspace remove failed", result.message);
      });
    },
    [workspaces],
  );

  // Apply resolved theme to documentElement (data-theme attribute).
  // Also subscribes to OS prefers-color-scheme when preference === "system".
  useThemeEffect();

  // Apply --window-opacity CSS property to documentElement.
  useWindowOpacityEffect();

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
        <div className="flex flex-1 min-h-0 overflow-hidden gap-[6px] p-[6px]">
          <Sidebar
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={handleSelectWorkspace}
            onAddWorkspace={handleAddWorkspace}
            onRemoveWorkspace={handleRemoveWorkspace}
          />
          <FilesPanel />
          <div className="grid grid-cols-1 grid-rows-1 flex-1 min-w-0 overflow-hidden">
            {workspaces.length === 0 && (
              <div className="flex flex-col island-surface rounded-(--radius-island) overflow-hidden">
                <WelcomeScreen onAddWorkspace={handleAddWorkspace} />
              </div>
            )}
            {mountedWorkspaces.map((ws) => (
              <WorkspacePanel key={ws.id} workspace={ws} isActive={ws.id === activeWorkspaceId} />
            ))}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
