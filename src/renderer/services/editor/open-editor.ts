// Editor open/reveal service entry point.
// Owns openOrReveal semantics and group routing for editor tabs; implementation follows Stage 4.

import { Grid } from "@/engine/split";
import { closeTab, openEditorTab, openTabInNewSplit, revealTab } from "@/state/operations/tabs";
import { useLayoutStore } from "@/state/stores/layout";
import { defaultTitle, useTabsStore } from "@/state/stores/tabs";
import type { EditorInput, EditorTabLocation, OpenEditorOptions } from "./types";

// When true, single-click file opens use a shared preview slot per group
// (VSCode-style: italic title, replaced on next single-click).
export const PREVIEW_ENABLED = true;

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

  const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
  const activeTabId = activeLeaf?.tabIds.find(matchesEditorPath);
  if (activeLeaf && activeTabId) {
    return { groupId: activeLeaf.id, tabId: activeTabId };
  }

  const found = Grid.findLeafByTab(layout.root, matchesEditorPath);
  if (!found) return null;
  return { groupId: found.leaf.id, tabId: found.tabId };
}

/**
 * Search for an editor tab with the given filePath only within the specified
 * group (leaf). Returns null when the group does not exist or has no matching
 * tab.
 */
export function findEditorTabInGroup(
  workspaceId: string,
  groupId: string,
  filePath: string,
): EditorTabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const leaf = Grid.findLeaf(layout.root, groupId);
  if (!leaf) return null;

  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const targetPath = normalizeFilePath(filePath);

  const tabId = leaf.tabIds.find((id) => {
    const tab = tabsById[id];
    return (
      tab?.type === "editor" &&
      normalizeFilePath((tab.props as EditorInput).filePath) === targetPath
    );
  });

  if (!tabId) return null;
  return { groupId: leaf.id, tabId };
}

/**
 * Find the preview slot (the single isPreview=true editor tab) in a group.
 * Returns null when none exists.
 */
export function findPreviewTabInGroup(
  workspaceId: string,
  groupId: string,
): EditorTabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const leaf = Grid.findLeaf(layout.root, groupId);
  if (!leaf) return null;

  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};

  const tabId = leaf.tabIds.find((id) => {
    const tab = tabsById[id];
    return tab?.type === "editor" && tab.isPreview;
  });

  if (!tabId) return null;
  return { groupId: leaf.id, tabId };
}

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
      "editor",
      input,
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
        const newTitle = defaultTitle("editor", input);
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

export function closeEditor(tabId: string): void {
  const byWorkspace = useTabsStore.getState().byWorkspace;
  for (const [workspaceId, tabs] of Object.entries(byWorkspace)) {
    if (tabs[tabId]?.type !== "editor") continue;
    closeTab(workspaceId, tabId);
    return;
  }
}
