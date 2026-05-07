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

import { useTabsStore } from "@/state/stores/tabs";
import { subscribeAllDirtyTransitions } from "./dirty-tracker";
import { cacheUriToFilePath } from "./model-cache";

/**
 * Promote every preview editor tab pointing at `filePath` to permanent
 * across every workspace. Idempotent — already-permanent tabs are no-ops
 * via tabsStore.promoteFromPreview.
 *
 * Centralized here because two separate triggers want this exact
 * behaviour: a clean→dirty transition (the user typed) and an explicit
 * save (Cmd+S, even when the buffer is clean). VSCode's
 * editorService.save() takes the same shortcut on
 * `SaveReason.EXPLICIT`.
 */
export function promoteAllPreviewTabsForFile(filePath: string): void {
  const tabsStore = useTabsStore.getState();
  for (const [workspaceId, wsRecord] of Object.entries(tabsStore.byWorkspace)) {
    for (const tab of Object.values(wsRecord)) {
      if (tab.type !== "editor") continue;
      if (!tab.isPreview) continue;
      if (tab.props.filePath !== filePath) continue;
      tabsStore.promoteFromPreview(workspaceId, tab.id);
    }
  }
}

let unsubscribe: (() => void) | null = null;

export function startPromoteOnDirtyPolicy(): void {
  if (unsubscribe) return;

  unsubscribe = subscribeAllDirtyTransitions((event) => {
    if (!event.isDirty) return; // we only care about clean → dirty

    const filePath = cacheUriToFilePath(event.cacheUri);
    if (!filePath) return;

    promoteAllPreviewTabsForFile(filePath);
  });
}

export function stopPromoteOnDirtyPolicyForTests(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
