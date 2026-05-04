// Editor open/reveal service entry point.
// Owns openOrReveal semantics and group routing for editor tabs; implementation follows Stage 4.

import { Grid } from "@/engine/split";
import { closeTab, openEditorTab, openTabInNewSplit, revealTab } from "@/state/operations";
import { useLayoutStore } from "@/state/stores/layout";
import { useTabsStore } from "@/state/stores/tabs";
import type { EditorInput, EditorTabLocation, OpenEditorOptions } from "./types";

function normalizeFilePath(filePath: string): string {
  if (filePath === "") return ".";

  const isAbsolute = filePath.startsWith("/");
  const hasTrailingSlash = filePath.endsWith("/");
  const parts: string[] = [];

  for (const part of filePath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const previous = parts.at(-1);
      if (previous && previous !== "..") {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  let normalized = `${isAbsolute ? "/" : ""}${parts.join("/")}`;
  if (normalized === "") normalized = isAbsolute ? "/" : ".";
  if (hasTrailingSlash && normalized !== "/") normalized += "/";
  return normalized;
}

export function findEditorTab(workspaceId: string, filePath: string): EditorTabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const targetPath = normalizeFilePath(filePath);
  const matchesEditorPath = (tabId: string) => {
    const tab = tabsById[tabId];
    return (
      tab?.type === "editor" &&
      normalizeFilePath((tab.props as EditorInput).filePath) === targetPath
    );
  };

  const activeLeaf = Grid.findView(layout.root, layout.activeGroupId);
  const activeTabId = activeLeaf?.tabIds.find(matchesEditorPath);
  if (activeLeaf && activeTabId) {
    return { groupId: activeLeaf.id, tabId: activeTabId };
  }

  const found = Grid.findLeafByTab(layout.root, matchesEditorPath);
  if (!found) return null;
  return { groupId: found.leaf.id, tabId: found.tabId };
}

export function openOrRevealEditor(
  input: EditorInput,
  opts: OpenEditorOptions = {},
): EditorTabLocation {
  useLayoutStore.getState().ensureLayout(input.workspaceId);

  if (opts.newSplit) {
    const { orientation, side } = opts.newSplit;
    const { newLeafId, tabId } = openTabInNewSplit(
      input.workspaceId,
      "editor",
      input,
      orientation,
      side,
    );
    return { groupId: newLeafId, tabId };
  }

  if (opts.revealIfOpened ?? true) {
    const existing = findEditorTab(input.workspaceId, input.filePath);
    if (existing) {
      revealTab(input.workspaceId, existing.groupId, existing.tabId);
      return existing;
    }
  }

  const tab = openEditorTab(input.workspaceId, input);
  const layout = useLayoutStore.getState().byWorkspace[input.workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${input.workspaceId}`);
  const groupId = layout.activeGroupId;
  return { groupId, tabId: tab.id };
}

export function closeEditor(tabId: string): void {
  const byWorkspace = useTabsStore.getState().byWorkspace;
  for (const [workspaceId, tabs] of Object.entries(byWorkspace)) {
    if (tabs[tabId]?.type !== "editor") continue;
    closeTab(workspaceId, tabId);
    return;
  }
}
