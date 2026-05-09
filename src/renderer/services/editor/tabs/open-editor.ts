/**
 * Open / reveal an editor tab in the active group, with VSCode-parity
 * preview-slot semantics. The two related but distinct concerns —
 * lookup over the existing layout, and tab close/external-open variants —
 * live in their own files (`tab-lookup.ts`, `close-editor.ts`,
 * `open-external-editor.ts`); this file is just the open/reveal entry.
 */

import { openEditorTab, openTabInNewSplit, revealTab } from "@/state/operations/tabs";
import { useLayoutStore } from "@/state/stores/layout";
import { defaultTitle, useTabsStore } from "@/state/stores/tabs";
import type { EditorInput, EditorTabLocation, OpenEditorOptions } from "../types";
import { findEditorTabInGroup, findPreviewTabInGroup } from "./tab-lookup";

// When true, single-click file opens use a shared preview slot per group
// (VSCode-style: italic title, replaced on next single-click).
export const PREVIEW_ENABLED = true;

export function openOrRevealEditor(
  input: EditorInput,
  opts: OpenEditorOptions = {},
): EditorTabLocation {
  useLayoutStore.getState().ensureLayout(input.workspaceId);

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
      input.workspaceId,
      { type: "editor", props: input },
      orientation,
      side,
      isPreview,
    );
    return { groupId: newLeafId, tabId };
  }

  if (opts.revealIfOpened ?? true) {
    const layout = useLayoutStore.getState().byWorkspace[input.workspaceId];
    if (layout) {
      const existing = findEditorTabInGroup(
        input.workspaceId,
        layout.activeGroupId,
        input.filePath,
      );
      if (existing) {
        revealTab(input.workspaceId, existing.groupId, existing.tabId);
        // Re-selecting an existing tab promotes it from preview (if it was one).
        useTabsStore.getState().promoteFromPreview(input.workspaceId, existing.tabId);
        return existing;
      }
    }
  }

  if (allowPreview) {
    const layout = useLayoutStore.getState().byWorkspace[input.workspaceId];
    if (layout) {
      const previewSlot = findPreviewTabInGroup(input.workspaceId, layout.activeGroupId);
      if (previewSlot) {
        // Reuse the existing preview slot: swap filePath/title, keep isPreview=true.
        const newTitle = defaultTitle({ type: "editor", props: input });
        useTabsStore
          .getState()
          .replacePreviewTab(input.workspaceId, previewSlot.tabId, input, newTitle);
        revealTab(input.workspaceId, previewSlot.groupId, previewSlot.tabId);
        return previewSlot;
      }
    }
  }

  const isPreview = allowPreview;
  const tab = openEditorTab(input.workspaceId, input, undefined, isPreview);
  const layout = useLayoutStore.getState().byWorkspace[input.workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${input.workspaceId}`);
  const groupId = layout.activeGroupId;
  return { groupId, tabId: tab.id };
}
