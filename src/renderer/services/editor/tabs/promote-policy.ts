import { useTabsStore } from "@/state/stores/tabs";
import { parseCacheUri } from "../model/cache";
import { subscribeAllDirtyTransitions } from "../model/dirty-tracker";
import { workingFileOfDiff } from "./diff-working-file";

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
    if (!event.isDirty) return;

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
