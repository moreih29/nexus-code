import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { ipcCall } from "./ipc/client";
import { useActiveStore } from "./store/active";
import { useTabsStore } from "./store/tabs";
import { useUIStore } from "./store/ui";
import { useWorkspacesStore } from "./store/workspaces";

export function App() {
  const { workspaces, setAll } = useWorkspacesStore();
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveStore();

  // Workspaces that have been activated at least once in this session.
  // Their <WorkspacePanel> stays mounted (CSS-hidden when inactive) so PTYs
  // survive workspace switches. Pruned when the workspace itself disappears.
  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set());

  // Boot: hydrate UI state (sidebar width) from persisted app state.
  useEffect(() => {
    ipcCall("appState", "get", undefined).then((state) => {
      useUIStore.getState().hydrate(state.sidebarWidth);
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

  // Prune mounted set when a workspace disappears so its panel unmounts and
  // TerminalView cleanup kills its PTYs.
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
      // panel unmount triggers TerminalView cleanup → PTY kill.
      ipcCall("workspace", "remove", { id }).catch(() => {});
    },
    [workspaces],
  );

  // Cmd+E: open file picker and add an EditorView tab to the active workspace.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === "e") {
        e.preventDefault();
        const wsId = useActiveStore.getState().activeWorkspaceId;
        if (!wsId) return;
        ipcCall("dialog", "showOpenFile", {
          title: "Open File",
          filters: [
            { name: "TypeScript / JavaScript", extensions: ["ts", "tsx", "js", "jsx"] },
            { name: "All Files", extensions: ["*"] },
          ],
        })
          .then(({ canceled, filePaths }) => {
            if (canceled || filePaths.length === 0) return;
            useTabsStore
              .getState()
              .addTab(wsId, "editor", { filePath: filePaths[0], workspaceId: wsId });
          })
          .catch(() => {});
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Render panels for every mounted workspace; only the active is visible.
  // Filter through `workspaces` so a deleted workspace's panel disappears
  // (its mounted-set entry is pruned by the effect above).
  const mountedWorkspaces = workspaces.filter((w) => mountedIds.has(w.id));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={handleSelectWorkspace}
          onAddWorkspace={handleAddWorkspace}
          onRemoveWorkspace={handleRemoveWorkspace}
        />
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
