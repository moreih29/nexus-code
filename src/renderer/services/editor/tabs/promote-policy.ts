// "Promote preview tabs on first edit" policy.
//
// Mirrors VSCode's editorGroupView.onDidChangeEditorDirty: the moment a
// file's buffer transitions from clean to dirty, every preview tab
// pointing at that file is promoted to a permanent (non-preview) tab.
// Subsequent edits are no-ops because the dirty-tracker only fires
// transition events on flips, not on every keystroke.
//
// Several tabs in one workspace can show the same model. Their preview
// states are independent, so promote them together when that model changes.

import { useTabsStore } from "@/state/stores/tabs";
import { parseCacheUri } from "../model/cache";
import { subscribeAllDirtyTransitions } from "../model/dirty-tracker";
import { workingFileOfDiff } from "./diff-working-file";

/**
 * Promote preview tabs sharing the model identified by workspace and path.
 * Both editing and an explicit save make the preview permanent.
 */
export function promoteAllPreviewTabsForFile(workspaceId: string, filePath: string): void {
  const tabsStore = useTabsStore.getState();
  for (const tab of Object.values(tabsStore.byWorkspace[workspaceId] ?? {})) {
    if (!tab.isPreview) continue;
    const tabFilePath =
      tab.type === "editor" && tab.props.workspaceId === workspaceId
        ? tab.props.filePath
        : tab.type === "editor.diff" && tab.props.workspaceId === workspaceId
          ? workingFileOfDiff(tab.props)
          : null;
    if (tabFilePath === filePath) tabsStore.promoteFromPreview(workspaceId, tab.id);
  }
}

let unsubscribe: (() => void) | null = null;

export function startPromoteOnDirtyPolicy(): void {
  if (unsubscribe) return;

  unsubscribe = subscribeAllDirtyTransitions((event) => {
    if (!event.isDirty) return; // we only care about clean → dirty

    const file = parseCacheUri(event.cacheUri);
    if (file) promoteAllPreviewTabsForFile(file.workspaceId, file.filePath);
  });
}

export function stopPromoteOnDirtyPolicyForTests(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
