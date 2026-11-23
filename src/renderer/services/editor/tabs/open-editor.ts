import {
  findAnyPreviewTabInGroup,
  openEditorTab,
  openTabInNewSplit,
  reclaimPreviewSlot,
  revealTab,
} from "@/state/operations/tabs";
import { useLayoutStore } from "@/state/stores/layout";
import { defaultTitle, useTabsStore } from "@/state/stores/tabs";
import type { EditorInput, EditorTabLocation, OpenEditorOptions } from "../types";
import { findEditorTabInGroup } from "./tab-lookup";

export const PREVIEW_ENABLED = true;

export function openOrRevealEditor(
  input: EditorInput,
  opts: OpenEditorOptions = {},
): EditorTabLocation {
  const editorInput = input;
  useLayoutStore.getState().ensureLayout(editorInput.workspaceId);

  const allowPreview = opts.preview !== false && PREVIEW_ENABLED;

  if (opts.newSplit) {
    const { orientation, side, isPreview = false } = opts.newSplit;
    const { newLeafId, tabId } = openTabInNewSplit(
      editorInput.workspaceId,
      { type: "editor", props: editorInput },
      orientation,
      side,
      isPreview,
    );
    return { groupId: newLeafId, tabId };
  }

  if (opts.revealIfOpened ?? true) {
    const layout = useLayoutStore.getState().byWorkspace[editorInput.workspaceId];
    if (layout) {
      const existing = findEditorTabInGroup(
        editorInput.workspaceId,
        layout.activeGroupId,
        editorInput.filePath,
      );
      if (existing) {
        revealTab(editorInput.workspaceId, existing.groupId, existing.tabId);
        useTabsStore.getState().promoteFromPreview(editorInput.workspaceId, existing.tabId);
        return existing;
      }
    }
  }

  if (allowPreview) {
    const layout = useLayoutStore.getState().byWorkspace[editorInput.workspaceId];
    if (layout) {
      const slot = findAnyPreviewTabInGroup(editorInput.workspaceId, layout.activeGroupId);
      if (slot) {
        if (slot.tab.type === "editor") {
          const newTitle = defaultTitle({ type: "editor", props: editorInput });
          useTabsStore
            .getState()
            .replacePreviewTab(editorInput.workspaceId, slot.tabId, editorInput, newTitle);
          revealTab(editorInput.workspaceId, slot.groupId, slot.tabId);
          return { groupId: slot.groupId, tabId: slot.tabId };
        }
        const insertIndex = reclaimPreviewSlot(editorInput.workspaceId, slot);
        const tab = openEditorTab(
          editorInput.workspaceId,
          editorInput,
          { groupId: layout.activeGroupId, index: insertIndex },
          true,
        );
        return { groupId: layout.activeGroupId, tabId: tab.id };
      }
    }
  }

  const isPreview = allowPreview;
  const tab = openEditorTab(editorInput.workspaceId, editorInput, undefined, isPreview);
  const layout = useLayoutStore.getState().byWorkspace[editorInput.workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${editorInput.workspaceId}`);
  const groupId = layout.activeGroupId;
  return { groupId, tabId: tab.id };
}
