import { useMonaco } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceMeta } from "../shared/types/workspace";
import { bootstrapAppState, bootstrapLspEnabled, bootstrapWorkspaces } from "./bootstrap";
import { useCommandBridge } from "./commands/use-command-bridge";
import { FilesPanel } from "./components/files";
import { GlobalRoots } from "./components/global-roots";
import { AppearancePanel } from "./components/settings/panels/appearance-panel";
import { EditorPanel } from "./components/settings/panels/editor-panel";
import { TerminalPanel } from "./components/settings/panels/terminal-panel";
import { SettingsDialog } from "./components/settings/settings-dialog";
import type { SettingsNavItem } from "./components/settings/types";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { Sidebar } from "./components/workbench/sidebar";
import { TitleBar } from "./components/workbench/title-bar";
import { WelcomeScreen } from "./components/workbench/welcome-screen";
import { AddWorkspaceDialog } from "./components/workspace/add-workspace";
import { WorkspacePanel } from "./components/workspace/panel";
import { showRemoveWorkspaceConfirm } from "./components/workspace/remove-workspace-dialog";
import { useThemeEffect } from "./hooks/use-theme-effect";
import { useWindowOpacityEffect } from "./hooks/use-window-opacity-effect";
import { ipcCallResult } from "./ipc/client";
import { useGlobalKeybindings } from "./keybindings/use-global-keybindings";
import { initializeEditorServices } from "./services/editor";
import { rehydrateLspForWorkspace } from "./services/editor/model/cache";
import { useActiveStore } from "./state/stores/active";
import { useEditorFontStore } from "./state/stores/editor-font";
import { useSettingsUIStore } from "./state/stores/settings-ui";
import { useTerminalStore } from "./state/stores/terminal";
import { useThemeStore } from "./state/stores/theme";
import { useWindowOpacityStore } from "./state/stores/window-opacity";
import { useWorkspacesStore } from "./state/stores/workspaces";

export function App() {
  const monaco = useMonaco();
  const { workspaces, setAll } = useWorkspacesStore();
  const { activeWorkspaceId, setActiveWorkspaceId } = useActiveStore();
  const settingsOpen = useSettingsUIStore((s) => s.settingsOpen);
  const settingsInitialActiveId = useSettingsUIStore((s) => s.initialActiveId);
  const closeSettings = useSettingsUIStore((s) => s.closeSettings);

  // Settings nav — each row carries an optional `dirty` dot. Dirty is
  // **session-scoped**: it means "this value changed while the current
  // Settings dialog session was open", not "this value diverges from the
  // built-in default". Settings auto-persist on every setter call, so once
  // the user closes the dialog we treat the new values as the new baseline.
  //
  // Implementation: when settingsOpen flips false → true we snapshot every
  // tracked field. While the dialog is open, dirty = current !== snapshot.
  // When the dialog closes, the snapshot is wiped so the next open starts
  // clean.
  const themePreference = useThemeStore((s) => s.preference);
  const opacity = useWindowOpacityStore((s) => s.opacity);
  const editorFontSize = useEditorFontStore((s) => s.size);
  const editorFontFamily = useEditorFontStore((s) => s.family);
  const editorFontLigatures = useEditorFontStore((s) => s.ligatures);
  const editorFontLineHeight = useEditorFontStore((s) => s.lineHeight);
  const terminalFontSize = useTerminalStore((s) => s.fontSize);
  const terminalCursorStyle = useTerminalStore((s) => s.cursorStyle);

  interface SettingsSnapshot {
    themePreference: typeof themePreference;
    opacity: number;
    editorFontSize: typeof editorFontSize;
    editorFontFamily: typeof editorFontFamily;
    editorFontLigatures: typeof editorFontLigatures;
    editorFontLineHeight: typeof editorFontLineHeight;
    terminalFontSize: typeof terminalFontSize;
    terminalCursorStyle: typeof terminalCursorStyle;
  }
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsSnapshot | null>(null);

  // Capture on open, clear on close. We deliberately depend only on
  // settingsOpen so the snapshot is taken exactly once per session and never
  // updated mid-session (otherwise dirty would always be false).
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot is captured at the moment of opening; mid-session reads must not refresh it
  useEffect(() => {
    if (settingsOpen) {
      setSettingsSnapshot({
        themePreference,
        opacity,
        editorFontSize,
        editorFontFamily,
        editorFontLigatures,
        editorFontLineHeight,
        terminalFontSize,
        terminalCursorStyle,
      });
    } else {
      setSettingsSnapshot(null);
    }
  }, [settingsOpen]);

  const settingsNav = useMemo<SettingsNavItem[]>(() => {
    const snap = settingsSnapshot;
    const appearanceDirty =
      snap !== null && (themePreference !== snap.themePreference || opacity !== snap.opacity);
    const editorDirty =
      snap !== null &&
      (editorFontSize !== snap.editorFontSize ||
        editorFontFamily !== snap.editorFontFamily ||
        editorFontLigatures !== snap.editorFontLigatures ||
        editorFontLineHeight !== snap.editorFontLineHeight);
    const terminalDirty =
      snap !== null &&
      (terminalFontSize !== snap.terminalFontSize ||
        terminalCursorStyle !== snap.terminalCursorStyle);
    return [
      {
        id: "appearance",
        label: "Appearance",
        group: "Settings",
        keywords: ["theme", "opacity"],
        dirty: appearanceDirty,
      },
      {
        id: "editor",
        label: "Editor",
        group: "Settings",
        keywords: ["font", "size", "family", "ligatures", "line height"],
        dirty: editorDirty,
      },
      {
        id: "terminal",
        label: "Terminal",
        group: "Settings",
        keywords: ["font", "size", "cursor"],
        dirty: terminalDirty,
      },
    ];
  }, [
    settingsSnapshot,
    themePreference,
    opacity,
    editorFontSize,
    editorFontFamily,
    editorFontLigatures,
    editorFontLineHeight,
    terminalFontSize,
    terminalCursorStyle,
  ]);

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

  // Boot: hydrate per-workspace LSP enabled-languages state.
  // Runs after workspaces are loaded so the list is non-empty and every
  // workspace's enabled list is fetched in one parallel batch. The store is
  // populated before any editor model fires its first didOpen (models are
  // mounted lazily when their tab becomes visible, after the workspace panel
  // renders, which is after this effect runs).
  useEffect(() => {
    if (workspaces.length > 0) {
      void bootstrapLspEnabled(workspaces);
    }
  }, [workspaces]);

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

  // Apply resolved theme to documentElement (data-theme attribute) and
  // dispatch "nexus:theme-changed" for Monaco / xterm sync.
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
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            if (!open) closeSettings();
          }}
          nav={settingsNav}
          defaultActiveId={settingsInitialActiveId}
        >
          {(activeId) => {
            if (activeId === "appearance") return <AppearancePanel />;
            if (activeId === "editor") return <EditorPanel />;
            if (activeId === "terminal") return <TerminalPanel />;
            return null;
          }}
        </SettingsDialog>
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
