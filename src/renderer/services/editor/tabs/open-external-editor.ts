import { openEditorTab } from "@/state/operations/tabs";
import { useLayoutStore } from "@/state/stores/layout";
import type { EditorInput, EditorTabLocation } from "../types";

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

  const tab = openEditorTab(input.workspaceId, props, undefined, true);
  const layout = useLayoutStore.getState().byWorkspace[input.workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${input.workspaceId}`);
  return { groupId: layout.activeGroupId, tabId: tab.id };
}
