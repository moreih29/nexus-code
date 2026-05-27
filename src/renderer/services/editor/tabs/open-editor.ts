/**
 * Open / reveal an editor tab in the active group, with VSCode-parity
 * preview-slot semantics. The two related but distinct concerns —
 * lookup over the existing layout, and tab close/external-open variants —
 * live in their own files (`tab-lookup.ts`, `close-editor.ts`,
 * `open-external-editor.ts`); this file is just the open/reveal entry.
 */

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

// When true, single-click file opens use a shared preview slot per group
// (VSCode-style: italic title, replaced on next single-click).
export const PREVIEW_ENABLED = true;

export function openOrRevealEditor(
  input: EditorInput,
  opts: OpenEditorOptions = {},
): EditorTabLocation {
  const editorInput = input;
  useLayoutStore.getState().ensureLayout(editorInput.workspaceId);

  // VSCode parity: callers can opt out of the preview slot entirely
  // (e.g. file-tree double-click). When `preview === false`, we
  //   - skip preview-slot reuse,
  //   - create new tabs as permanent (isPreview=false),
  //   - still promote any existing tab to permanent on reveal.
  // The default stays `true` to preserve current single-click behaviour.
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
        // Re-selecting an existing tab promotes it from preview (if it was one).
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
          // Same-type slot — swap filePath/title in place, keep isPreview=true.
          const newTitle = defaultTitle({ type: "editor", props: editorInput });
          useTabsStore
            .getState()
            .replacePreviewTab(editorInput.workspaceId, slot.tabId, editorInput, newTitle);
          revealTab(editorInput.workspaceId, slot.groupId, slot.tabId);
          return { groupId: slot.groupId, tabId: slot.tabId };
        }
        // Cross-type slot (diff / commit preview) — reclaim and slot in place.
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
