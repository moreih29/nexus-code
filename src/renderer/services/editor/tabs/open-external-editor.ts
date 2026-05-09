import { openEditorTab } from "@/state/operations/tabs";
import { useLayoutStore } from "@/state/stores/layout";
import type { EditorInput, EditorTabLocation } from "../types";

/**
 * Open an external (out-of-workspace) file as a read-only preview tab in the
 * given workspace. Uses the regular tab/layout machinery so the tab appears in
 * the active group like any other editor tab, but sets origin="external" and
 * readOnly=true so the model layer uses loadExternalEntry and the UX shows the
 * ReadOnlyBanner and lock icon (T6).
 */
export function openExternalEditor(input: {
  workspaceId: string;
  filePath: string;
}): EditorTabLocation {
  useLayoutStore.getState().ensureLayout(input.workspaceId);

  const props: EditorInput = {
    workspaceId: input.workspaceId,
    filePath: input.filePath,
    origin: "external",
    readOnly: true,
  };

  const tab = openEditorTab(input.workspaceId, props, undefined, /* isPreview */ true);
  const layout = useLayoutStore.getState().byWorkspace[input.workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${input.workspaceId}`);
  return { groupId: layout.activeGroupId, tabId: tab.id };
}
