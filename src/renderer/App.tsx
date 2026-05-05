import { useMonaco } from "@monaco-editor/react";
import { useCallback, useEffect, useState } from "react";
import { useCommandBridge } from "./commands/use-command-bridge";
import { FilesPanel } from "./components/files";
import { GlobalRoots } from "./components/global-roots";
import { Sidebar } from "./components/workbench/sidebar";
import { TitleBar } from "./components/workbench/title-bar";
import { WorkspacePanel } from "./components/workspace/workspace-panel";
import { ipcCall } from "./ipc/client";
import { useGlobalKeybindings } from "./keybindings/use-global-keybindings";
import { initializeEditorServices } from "./services/editor";
import { registerStatePersistence } from "./state/persistence";
import { useActiveStore } from "./state/stores/active";
import { useLayoutStore } from "./state/stores/layout";
import { useTabsStore } from "./state/stores/tabs";
import { useUIStore } from "./state/stores/ui";
import { useWorkspacesStore } from "./state/stores/workspaces";

export function App() {
  const monaco = useMonaco();
  const { workspaces, setAll } = useWorkspacesStore();
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveStore();

  // Workspaces that have been activated at least once in this session.
  // Their <WorkspacePanel> stays mounted (CSS-hidden when inactive) so PTYs
  // survive workspace switches. Pruned when the workspace itself disappears.
  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!monaco) return;
    initializeEditorServices(monaco);
  }, [monaco]);

  // Boot: hydrate UI state (sidebar width, files panel) and layout/tabs from persisted app state.
  useEffect(() => {
    ipcCall("appState", "get", undefined).then((state) => {
      useUIStore.getState().hydrate({
        sidebarWidth: state.sidebarWidth,
        filesPanelWidth: state.filesPanelWidth,
      });

      // Hydrate layout + tabs from persisted snapshots
      if (state.layoutByWorkspace) {
        for (const [wsId, snap] of Object.entries(state.layoutByWorkspace)) {
          try {
            // Restore tabs record; normalize isPreview/isPinned (missing in old snapshots → false)
            const tabsMap: Record<
              string,
              (typeof snap.tabs)[number] & { isPreview: boolean; isPinned: boolean }
            > = {};
            for (const t of snap.tabs) {
              const isPreview =
                "isPreview" in t && typeof t.isPreview === "boolean" ? t.isPreview : false;
              const isPinned =
                "isPinned" in t && typeof t.isPinned === "boolean" ? t.isPinned : false;
              tabsMap[t.id] = { ...t, isPreview, isPinned };
            }
            useTabsStore.setState((s) => ({
              byWorkspace: { ...s.byWorkspace, [wsId]: tabsMap },
            }));

            // Restore layout (sanitize against known tab ids)
            const knownTabIds = new Set(snap.tabs.map((t) => t.id));
            useLayoutStore
              .getState()
              .hydrate(wsId, { root: snap.root, activeGroupId: snap.activeGroupId }, knownTabIds);
          } catch {
            // Silent repair: skip invalid snapshot for this workspace
          }
        }
      }

      // Register persistence subscriber after hydrate. Zustand `subscribe` fires
      // only on subsequent state changes — past hydrate setStates have already
      // flushed synchronously by the time this line runs, so no replay storm.
      registerStatePersistence();
    });
  }, []);

  // Boot: load workspaces from main, activate first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: boot-once effect; store setters are stable
  useEffect(() => {
    ipcCall("workspace", "list", undefined).then((list) => {
      setAll(list);
      if (list.length > 0) {
        const first = list[0];
        setActiveWorkspaceId(first.id);
        ipcCall("workspace", "activate", { id: first.id }).catch(() => {});
      }
    });
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
        ipcCall("workspace", "activate", { id: next }).catch(() => {});
      }
    }
  }, [workspaces, activeWorkspaceId, setActiveWorkspaceId]);

  const handleSelectWorkspace = useCallback(
    (id: string) => {
      setActiveWorkspaceId(id);
      ipcCall("workspace", "activate", { id }).catch(() => {});
    },
    [setActiveWorkspaceId],
  );

  const handleAddWorkspace = useCallback(async () => {
    const { canceled, filePaths } = await ipcCall("dialog", "showOpenDirectory", {
      title: "Select workspace folder",
    });
    if (canceled || filePaths.length === 0) return;
    const rootPath = filePaths[0];
    const meta = await ipcCall("workspace", "create", { rootPath });
    setActiveWorkspaceId(meta.id);
    await ipcCall("workspace", "activate", { id: meta.id }).catch(() => {});
    // Tab seeding is handled by <WorkspacePanel> on first mount.
  }, [setActiveWorkspaceId]);

  const handleRemoveWorkspace = useCallback(
    (id: string) => {
      const target = workspaces.find((w) => w.id === id);
      const label = target ? `"${target.name}"` : "this workspace";
      // Native confirm is sufficient — only the registration is removed; on-disk folder is untouched.
      const ok = window.confirm(
        `Remove ${label} from Nexus?\n\nThe folder on disk is not touched.`,
      );
      if (!ok) return;
      // tabs store subscribes to `workspace:removed` and clears its slice;
      // that tab-record cleanup kills PTYs before panel unmount disposes views.
      ipcCall("workspace", "remove", { id }).catch(() => {});
    },
    [workspaces],
  );

  // Wire the keyboard dispatcher and the Application Menu IPC bridge to
  // the same command registry. Both surfaces resolve to one
  // implementation per command.
  useGlobalKeybindings();
  useCommandBridge();

  // Render panels for every mounted workspace; only the active is visible.
  // Filter through `workspaces` so a deleted workspace's panel disappears
  // (its mounted-set entry is pruned by the effect above).
  const mountedWorkspaces = workspaces.filter((w) => mountedIds.has(w.id));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <TitleBar />
      <GlobalRoots />
      <div className="flex flex-1 min-h-0 overflow-hidden">
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
            <div className="flex flex-1 items-center justify-center text-muted-foreground text-app-body">
              No workspace selected. Add one from the sidebar.
            </div>
          )}
          {mountedWorkspaces.map((ws) => (
            <WorkspacePanel key={ws.id} workspace={ws} isActive={ws.id === activeWorkspaceId} />
          ))}
        </div>
      </div>
    </div>
  );
}
