import { closeTab } from "@/state/operations/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import { cacheUriFor } from "../model/cache";
import { isDirty } from "../model/dirty-tracker";
import { isPathOrUnder } from "./retarget-tabs";

/**
 * Closes the workspace's editor tabs on `deletedPath`, or under it when it
 * was a folder, after the user deleted it in the app. Left open they show
 * "File or folder not found". A tab with unsaved changes stays open so they
 * can still be saved (VSCode parity).
 */
export function closeEditorTabsOfDeletedPath(workspaceId: string, deletedPath: string): void {
  const tabs = Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});
  for (const tab of tabs) {
    if (tab.type !== "editor" || tab.props.origin === "external") continue;
    if (!isPathOrUnder(tab.props.filePath, deletedPath)) continue;
    if (isDirty(cacheUriFor(workspaceId, tab.props.filePath))) continue;
    closeTab(workspaceId, tab.id);
  }
}
