// "Promote preview tabs on first edit" policy.
//
// Mirrors VSCode's editorGroupView.onDidChangeEditorDirty: the moment a
// file's buffer transitions from clean to dirty, every preview tab
// pointing at that file is promoted to a permanent (non-preview) tab.
// Subsequent edits are no-ops because the dirty-tracker only fires
// transition events on flips, not on every keystroke.
//
// One file (cacheUri) may be visible in multiple tabs across multiple
// workspaces — they all get promoted, since each one's preview state
// would survive otherwise and surprise the user when their typed changes
// look like they vanished on a single-click of another file.

import type { EditorTabProps } from "@/state/stores/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import { subscribeTransitions } from "./dirty-tracker";

/**
 * `cacheUri` for editor tabs is `file://${filePath}` (see model-cache).
 * Strip the prefix to get the absolute filePath stored in tab.props.
 */
function filePathFromCacheUri(cacheUri: string): string | null {
  return cacheUri.startsWith("file://") ? cacheUri.slice("file://".length) : null;
}

let unsubscribe: (() => void) | null = null;

export function startPromoteOnDirtyPolicy(): void {
  if (unsubscribe) return;

  unsubscribe = subscribeTransitions((event) => {
    if (!event.isDirty) return; // we only care about clean → dirty

    const filePath = filePathFromCacheUri(event.cacheUri);
    if (!filePath) return;

    const tabsStore = useTabsStore.getState();
    for (const [workspaceId, wsRecord] of Object.entries(tabsStore.byWorkspace)) {
      for (const tab of Object.values(wsRecord)) {
        if (tab.type !== "editor") continue;
        if (!tab.isPreview) continue;
        if ((tab.props as EditorTabProps).filePath !== filePath) continue;
        tabsStore.promoteFromPreview(workspaceId, tab.id);
      }
    }
  });
}

export function stopPromoteOnDirtyPolicyForTests(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
