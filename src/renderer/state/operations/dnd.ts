/**
 * D&D drop dispatchers — the entry points called by the workspace dnd
 * hooks (useDropTarget, useTabBarDropTarget) when the user releases a
 * supported drag onto a destination.
 *
 * Both dispatchers always re-resolve the source tab/owner against the
 * live store; payload `sourceGroupId` from the drag is treated as a
 * hint only.
 */

import type { DropZone } from "@/components/workspace/dnd/types";
import { Grid } from "@/engine/split";
import { findEditorTabInGroup } from "@/services/editor/open-editor";
import { useLayoutStore } from "../stores/layout";
import type { SplitOrientation } from "../stores/layout/types";
import { type EditorTabProps, useTabsStore } from "../stores/tabs";
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

/**
 * Result of a drop dispatch — useful for callers that want to focus the new
 * leaf or report telemetry. `null` means the drop was a no-op (self drop or
 * invalid target).
 */
export type DropResult =
  | { kind: "moved"; groupId: string; tabId: string }
  | { kind: "split"; groupId: string; tabId: string }
  | null;

/**
 * Move an existing tab into the given target zone of a destination group.
 *
 * Edge zones split the destination leaf and place the tab in the new leaf.
 * Center moves the tab into the destination leaf, optionally at a specific
 * insertion `index` (drop on a tab-bar slot — VSCode-style precise reorder).
 * Without `index`, center drops append to the end of the group.
 *
 * No-op when the result would not change the layout: same-leaf center with
 * no index (would already be there), same-leaf single-tab edge (split + hoist
 * loop), or a same-leaf reorder whose index is the tab's current position.
 */
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

  // Self-drop guards.
  if (owner.id === destLeaf.id) {
    if (target.zone === "center") {
      // Self center without index → no-op (already in this leaf, no reorder
      // intent expressed). Self center with index → reorder; allowed unless
      // the target index resolves to the current position (a true no-op).
      if (target.index === undefined) return null;
      const currentIdx = owner.tabIds.indexOf(tabId);
      if (currentIdx === target.index || currentIdx + 1 === target.index) return null;
    } else if (owner.tabIds.length === 1) {
      // Self edge with single tab → split + hoist undoes itself.
      return null;
    }
  }

  const isCrossGroup = owner.id !== destLeaf.id;

  if (target.zone === "center") {
    // VSCode parity: cross-group move where dest already has the same file →
    // reveal the existing tab and close the source. Without this, the same
    // file ends up in the dest group twice.
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
          }
          promoteTabIfPreview(workspaceId, existing.tabId);
          closeTab(workspaceId, tabId);
          return { kind: "moved", groupId: existing.groupId, tabId: existing.tabId };
        }
      }
    }

    useLayoutStore.getState().moveTab(workspaceId, tabId, destLeaf.id, target.index);
    // VSCode parity: editorGroupView.moveEditor unconditionally calls
    // model.pin(editor) — i.e. *any* drop-driven move (including a same-group
    // reorder) promotes the tab. Self-drop no-op cases were filtered above so
    // we never promote spuriously.
    promoteTabIfPreview(workspaceId, tabId);
    return { kind: "moved", groupId: destLeaf.id, tabId };
  }

  const split = zoneToSplit(target.zone);
  if (!split) return null;

  // Two-step: detach (handles hoist of the source if it becomes empty) then
  // split-and-attach (single set in the store, no placeholder frame).
  // React batches these two store updates because they fire inside the same
  // event-handler tick.
  useLayoutStore.getState().detachTab(workspaceId, tabId);
  const newLeafId = useLayoutStore
    .getState()
    .splitAndAttach(workspaceId, destLeaf.id, split.orientation, split.side, tabId);
  if (!newLeafId) return null;
  // Edge drops always land in a new leaf — always cross-group.
  promoteTabIfPreview(workspaceId, tabId);
  return { kind: "split", groupId: newLeafId, tabId };
}

/**
 * Open a file at the given target zone — creates a new editor tab and either
 * attaches it to the destination group (center) or splits the leaf and places
 * the tab in the new pane (edge).
 *
 * This dispatcher parallels openTabInNewSplit; it lives in the dnd module
 * because the trigger is always a file-tree → group drop.
 */
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
      }
      return { kind: "moved", groupId: existing.groupId, tabId: existing.tabId };
    }
    const tab = openEditorTab(workspaceId, props, { groupId: destLeaf.id });
    if (target.index !== undefined) {
      // openEditorTab attaches at the end; re-attach at the requested index
      // (attachTab dedupes existing entries before splicing).
      useLayoutStore.getState().attachTab(workspaceId, destLeaf.id, tab.id, target.index);
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
    // Roll back the orphan tab record if the split failed (e.g. layout
    // disappeared mid-call). Silent failure is fine here — file open is
    // user-initiated and a reattempt is cheap.
    useTabsStore.getState().removeTab(workspaceId, tab.id);
    return null;
  }
  return { kind: "split", groupId: newLeafId, tabId: tab.id };
}
