/**
 * What the nexus CLI reads and changes of the workbench around the tabs:
 * the groups and splits of a workspace's editor area, a tab's name, pin and
 * group, the sidebar and files panel, the file tree, and the problems the
 * language servers report.
 *
 * As with ./actions, nothing here takes keyboard focus.
 */

import { getEntryMetadata } from "@/services/editor/model/cache";
import { isMonacoReady, requireMonaco } from "@/services/editor/runtime/monaco-singleton";
import { moveTabToZone } from "@/state/operations/dnd";
import { reveal } from "@/state/operations/files";
import { closeGroup } from "@/state/operations/groups";
import { toggleTabPin } from "@/state/operations/tab-order";
import { useFilesStore } from "@/state/stores/files";
import { findLeaf } from "@/state/stores/layout/helpers";
import { useLayoutStore } from "@/state/stores/layout/store";
import type { LayoutNode } from "@/state/stores/layout/types";
import { useTabsStore } from "@/state/stores/tabs";
import { FILES_PANEL_MODE_DEFAULT, useUIStore } from "@/state/stores/ui";
import type { CliLayoutNode, CliPanels, CliProblem, CliUiOp } from "../../../shared/cli/ui";
import { runningProgram } from "../terminal/close-confirm";
import { type CliUiHandler, hasUnsavedChanges, tabRecord, UiRequestError } from "./actions";

function layoutOf(workspaceId: string) {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) {
    throw new UiRequestError(
      "that workspace's tabs are not loaded: it has not been opened since NexusCode started",
    );
  }
  return layout;
}

function toCli(node: LayoutNode): CliLayoutNode {
  if (node.kind === "leaf") {
    return { kind: "group", id: node.id, tabIds: [...node.tabIds], shownTabId: node.activeTabId };
  }
  return {
    kind: "split",
    id: node.id,
    direction: node.orientation === "horizontal" ? "columns" : "rows",
    ratio: node.ratio,
    first: toCli(node.first),
    second: toCli(node.second),
  };
}

const ZONES = { left: "left", right: "right", up: "top", down: "bottom" } as const;

/**
 * Moves a tab as a drop does, then gives the active group back: a drop
 * activates where the tab lands, but the user is still where they were.
 */
function moveKeepingActive(...args: Parameters<typeof moveTabToZone>) {
  const [workspaceId] = args;
  const before = layoutOf(workspaceId).activeGroupId;
  const result = moveTabToZone(...args);
  if (findLeaf(layoutOf(workspaceId).root, before)) {
    useLayoutStore.getState().setActiveGroup(workspaceId, before);
  }
  return result;
}

function panels(workspaceId: string): CliPanels {
  const ui = useUIStore.getState();
  return {
    sidebar: { visible: !ui.sidebarHidden, width: ui.sidebarWidth },
    files: {
      visible: !ui.filesPanelHidden,
      width: ui.filesPanelWidth,
      mode: ui.filesPanelModes.get(workspaceId) ?? FILES_PANEL_MODE_DEFAULT,
    },
  };
}

const SEVERITIES: Record<number, CliProblem["severity"]> = {
  8: "error",
  4: "warning",
  2: "info",
  1: "hint",
};

export type LayoutOp =
  | "layout.get"
  | "layout.split"
  | "layout.ratios"
  | "tab.move"
  | "group.close"
  | "tab.rename"
  | "tab.pin"
  | "panels.get"
  | "panels.set"
  | "files.reveal"
  | "problems.list";

export const layoutHandlers: { [K in LayoutOp & CliUiOp]: CliUiHandler<K> } = {
  "layout.get": async ({ workspaceId }) => {
    const layout = layoutOf(workspaceId);
    return { root: toCli(layout.root), activeGroupId: layout.activeGroupId };
  },

  "layout.split": async ({ workspaceId, tabId, groupId, side }) => {
    layoutOf(workspaceId);
    tabRecord(workspaceId, tabId);
    const result = moveKeepingActive(workspaceId, tabId, { groupId, zone: ZONES[side] });
    if (!result) {
      throw new UiRequestError("it is the only tab in that group; splitting would change nothing");
    }
    return { groupId: result.groupId };
  },

  "layout.ratios": async ({ workspaceId, ratios }) => {
    layoutOf(workspaceId);
    for (const { splitId, ratio } of ratios) {
      useLayoutStore.getState().setSplitRatio(workspaceId, splitId, ratio);
    }
    return {};
  },

  "tab.move": async ({ workspaceId, tabId, groupId, index }) => {
    layoutOf(workspaceId);
    tabRecord(workspaceId, tabId);
    moveKeepingActive(workspaceId, tabId, {
      groupId,
      zone: "center",
      ...(index === undefined ? {} : { index }),
    });
    return {};
  },

  "group.close": async ({ workspaceId, groupId, force }) => {
    const leaf = findLeaf(layoutOf(workspaceId).root, groupId);
    if (!leaf) throw new UiRequestError("that group is gone");
    for (const tabId of leaf.tabIds) {
      const tab = tabRecord(workspaceId, tabId);
      if (tab.type === "terminal") {
        if (force || tab.props.dead) continue;
        const program = await runningProgram(workspaceId, tabId);
        if (program !== null) {
          throw new UiRequestError(
            `${program} is running in ${tab.title}; add --force to close it anyway`,
          );
        }
      } else if (hasUnsavedChanges(workspaceId, tab)) {
        throw new UiRequestError(`${tab.title} has unsaved changes; save or close it in the app`);
      }
    }
    const closed = leaf.tabIds.length;
    closeGroup(workspaceId, groupId);
    return { closed };
  },

  "tab.rename": async ({ workspaceId, tabId, title }) => {
    tabRecord(workspaceId, tabId);
    useTabsStore.getState().renameTab(workspaceId, tabId, title);
    return { title: tabRecord(workspaceId, tabId).title };
  },

  "tab.pin": async ({ workspaceId, tabId, pinned }) => {
    if (tabRecord(workspaceId, tabId).isPinned !== pinned) toggleTabPin(workspaceId, tabId);
    return {};
  },

  "panels.get": async ({ workspaceId }) => panels(workspaceId),

  "panels.set": async ({ workspaceId, panel, visible, width, mode }) => {
    const ui = useUIStore.getState();
    if (mode !== undefined) ui.setFilesPanelMode(workspaceId, mode);
    if (width !== undefined) {
      if (panel === "sidebar") ui.setSidebarWidth(width, true);
      else ui.setFilesPanelWidth(width, true);
    }
    if (visible !== undefined) ui.setPanelHidden(panel, !visible);
    return panels(workspaceId);
  },

  "files.reveal": async ({ workspaceId, filePath }) => {
    if (!useFilesStore.getState().trees.has(workspaceId)) {
      throw new UiRequestError(
        "that workspace's file tree is not loaded: it has not been opened since NexusCode started",
      );
    }
    const ui = useUIStore.getState();
    ui.setFilesPanelMode(workspaceId, "tree");
    if (ui.filesPanelHidden) ui.setPanelHidden("files", false);
    await reveal(workspaceId, filePath);
    useFilesStore.getState().setSingleSelection(workspaceId, filePath);
    return {};
  },

  "problems.list": async ({ workspaceId }) => {
    if (!isMonacoReady()) return { problems: [] };
    const problems: CliProblem[] = [];
    for (const marker of requireMonaco().editor.getModelMarkers({})) {
      const meta = getEntryMetadata(marker.resource.toString());
      if (!meta || meta.workspaceId !== workspaceId) continue;
      const code = typeof marker.code === "object" ? marker.code?.value : marker.code;
      problems.push({
        filePath: meta.filePath,
        line: marker.startLineNumber,
        column: marker.startColumn,
        severity: SEVERITIES[marker.severity] ?? "info",
        message: marker.message,
        ...(marker.source ? { source: marker.source } : {}),
        ...(code ? { code: String(code) } : {}),
      });
    }
    problems.sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column,
    );
    return { problems };
  },
};
