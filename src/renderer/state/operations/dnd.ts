import { Grid } from "@/engine";
import { findEditorTabInGroup } from "@/services/editor/tabs";
import type { DropZone } from "@/types/workbench-dnd";
import { useLayoutStore } from "../stores/layout";
import type { SplitOrientation } from "../stores/layout/types";
import { type EditorTabProps, useTabsStore } from "../stores/tabs";
import { normalizeGroupTabOrder } from "./tab-order";
import { closeTab, openEditorTab, revealTab } from "./tabs";

function promoteTabIfPreview(workspaceId: string, tabId: string): void {
  useTabsStore.getState().promoteFromPreview(workspaceId, tabId);
}

function zoneToSplit(
  zone: DropZone,
): { orientation: SplitOrientation; side: "before" | "after" } | null {
  switch (zone) {
    case "top":
      return { orientation: "vertical", side: "before" };
    case "bottom":
      return { orientation: "vertical", side: "after" };
    case "left":
      return { orientation: "horizontal", side: "before" };
    case "right":
      return { orientation: "horizontal", side: "after" };
    case "center":
      return null;
  }
}

export type DropResult =
  | { kind: "moved"; groupId: string; tabId: string }
  | { kind: "split"; groupId: string; tabId: string }
  | null;

export function moveTabToZone(
  workspaceId: string,
  tabId: string,
  target: { groupId: string; zone: DropZone; index?: number },
): DropResult {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const destLeaf = Grid.findLeaf(layout.root, target.groupId);
  if (!destLeaf) return null;

  const owner = Grid.allLeaves(layout.root).find((l) => l.tabIds.includes(tabId));
  if (!owner) return null;

  if (owner.id === destLeaf.id) {
    if (target.zone === "center") {
      if (target.index === undefined) return null;
      const currentIdx = owner.tabIds.indexOf(tabId);
      if (currentIdx === target.index || currentIdx + 1 === target.index) return null;
    } else if (owner.tabIds.length === 1) {
      return null;
    }
  }

  const isCrossGroup = owner.id !== destLeaf.id;

  if (target.zone === "center") {
    if (isCrossGroup) {
      const sourceTab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
      if (sourceTab?.type === "editor") {
        const existing = findEditorTabInGroup(workspaceId, destLeaf.id, sourceTab.props.filePath);
        if (existing && existing.tabId !== tabId) {
          revealTab(workspaceId, existing.groupId, existing.tabId);
          if (target.index !== undefined) {
            useLayoutStore
              .getState()
              .attachTab(workspaceId, existing.groupId, existing.tabId, target.index);
            normalizeGroupTabOrder(workspaceId, existing.groupId);
          }
          promoteTabIfPreview(workspaceId, existing.tabId);
          closeTab(workspaceId, tabId);
          return { kind: "moved", groupId: existing.groupId, tabId: existing.tabId };
        }
      }
    }

    const layoutStore = useLayoutStore.getState();
    layoutStore.moveTab(workspaceId, tabId, destLeaf.id, target.index);
    if (isCrossGroup) layoutStore.setActiveGroup(workspaceId, destLeaf.id);
    normalizeGroupTabOrder(workspaceId, destLeaf.id);
    promoteTabIfPreview(workspaceId, tabId);
    return { kind: "moved", groupId: destLeaf.id, tabId };
  }

  const split = zoneToSplit(target.zone);
  if (!split) return null;

  useLayoutStore.getState().detachTab(workspaceId, tabId);
  const newLeafId = useLayoutStore
    .getState()
    .splitAndAttach(workspaceId, destLeaf.id, split.orientation, split.side, tabId);
  if (!newLeafId) return null;
  promoteTabIfPreview(workspaceId, tabId);
  return { kind: "split", groupId: newLeafId, tabId };
}

export function openFileAtZone(
  workspaceId: string,
  filePath: string,
  target: { groupId: string; zone: DropZone; index?: number },
): DropResult {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const destLeaf = Grid.findLeaf(layout.root, target.groupId);
  if (!destLeaf) return null;

  const props: EditorTabProps = { workspaceId, filePath };

  if (target.zone === "center") {
    const existing = findEditorTabInGroup(workspaceId, destLeaf.id, filePath);
    if (existing) {
      revealTab(workspaceId, existing.groupId, existing.tabId);
      if (target.index !== undefined) {
        useLayoutStore.getState().attachTab(workspaceId, destLeaf.id, existing.tabId, target.index);
        normalizeGroupTabOrder(workspaceId, destLeaf.id);
      }
      return { kind: "moved", groupId: existing.groupId, tabId: existing.tabId };
    }
    const tab = openEditorTab(workspaceId, props, { groupId: destLeaf.id });
    if (target.index !== undefined) {
      useLayoutStore.getState().attachTab(workspaceId, destLeaf.id, tab.id, target.index);
      normalizeGroupTabOrder(workspaceId, destLeaf.id);
    }
    return { kind: "moved", groupId: destLeaf.id, tabId: tab.id };
  }

  const split = zoneToSplit(target.zone);
  if (!split) return null;

  const tab = useTabsStore.getState().createTab(workspaceId, { type: "editor", props });
  const newLeafId = useLayoutStore
    .getState()
    .splitAndAttach(workspaceId, destLeaf.id, split.orientation, split.side, tab.id);
  if (!newLeafId) {
    useTabsStore.getState().removeTab(workspaceId, tab.id);
    return null;
  }
  return { kind: "split", groupId: newLeafId, tabId: tab.id };
}
