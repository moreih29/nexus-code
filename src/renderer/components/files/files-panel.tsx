import { useMemo, useState } from "react";
import type { EditorInput } from "../../services/editor/types";
import { useActiveStore } from "../../state/stores/active";
import { useLayoutStore } from "../../state/stores/layout";
import { allLeaves } from "../../state/stores/layout/helpers";
import type { WorkspaceLayout } from "../../state/stores/layout/types";
import { type Tab, useTabsStore } from "../../state/stores/tabs";
import {
  FILES_PANEL_WIDTH_DEFAULT,
  FILES_PANEL_WIDTH_MAX,
  FILES_PANEL_WIDTH_MIN,
  useUIStore,
} from "../../state/stores/ui";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { OutlineSection } from "../lsp/outline";
import { ResizeHandle } from "../ui/resize-handle";
import { FileTree } from "./file-tree";

export const OUTLINE_COLLAPSE_VIEWPORT_WIDTH = 1100;
const EMPTY_TABS_BY_ID: Record<string, Tab> = {};

export function shouldDefaultCollapseOutline(viewportWidth?: number): boolean {
  if (viewportWidth !== undefined) return viewportWidth < OUTLINE_COLLAPSE_VIEWPORT_WIDTH;
  if (typeof window === "undefined") return false;
  return window.innerWidth < OUTLINE_COLLAPSE_VIEWPORT_WIDTH;
}

export function activeEditorInputFromLayout(
  layout: WorkspaceLayout | undefined,
  tabsById: Record<string, Tab>,
): EditorInput | null {
  if (!layout) return null;
  const activeLeaf = allLeaves(layout.root).find((leaf) => leaf.id === layout.activeGroupId);
  const activeTabId = activeLeaf?.activeTabId;
  const activeTab = activeTabId ? tabsById[activeTabId] : undefined;
  return activeTab?.type === "editor" ? activeTab.props : null;
}

export function FilesPanel() {
  const filesPanelWidth = useUIStore((s) => s.filesPanelWidth);
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const layout = useLayoutStore((s) =>
    activeWorkspaceId ? s.byWorkspace[activeWorkspaceId] : undefined,
  );
  const tabsById = useTabsStore((s) =>
    activeWorkspaceId ? (s.byWorkspace[activeWorkspaceId] ?? EMPTY_TABS_BY_ID) : EMPTY_TABS_BY_ID,
  );
  const [outlineCollapsed, setOutlineCollapsed] = useState(shouldDefaultCollapseOutline);
  const activeWorkspace = activeWorkspaceId
    ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? null)
    : null;
  const activeEditorInput = useMemo(
    () => activeEditorInputFromLayout(layout, tabsById),
    [layout, tabsById],
  );

  return (
    <aside
      className="relative shrink-0 bg-muted border-r border-r-mist-border flex flex-col"
      style={{ width: filesPanelWidth }}
    >
      {activeWorkspace ? (
        <>
          <div className="px-3 pt-3 pb-2 text-app-ui-xs uppercase tracking-[2.4px] text-stone-gray select-none truncate">
            {activeWorkspace.name}
          </div>
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
            <div
              className={cn("min-h-0 overflow-hidden", outlineCollapsed ? "flex-1" : "basis-[60%]")}
            >
              <FileTree workspaceId={activeWorkspace.id} rootAbsPath={activeWorkspace.rootPath} />
            </div>
            <div
              className={cn(
                "shrink-0 overflow-hidden border-t border-t-mist-border",
                outlineCollapsed ? "h-8" : "basis-[40%] min-h-[128px]",
              )}
            >
              <OutlineSection
                activeInput={activeEditorInput}
                collapsed={outlineCollapsed}
                onToggleCollapsed={() => setOutlineCollapsed((value) => !value)}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
          Select a workspace
          <br />
          to browse files.
        </div>
      )}
      <ResizeHandle
        value={filesPanelWidth}
        min={FILES_PANEL_WIDTH_MIN}
        max={FILES_PANEL_WIDTH_MAX}
        ariaLabel="Resize files panel"
        onResize={(width, persist) => useUIStore.getState().setFilesPanelWidth(width, persist)}
        onReset={() => useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT, true)}
      />
    </aside>
  );
}
