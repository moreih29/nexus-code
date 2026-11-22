// Opening what a Claude tab names as a tab of its own: in the group beside
// the Claude tab, split off when the tab is wide enough to share; in the
// Claude tab's own group when it is narrow and has no neighbour. From the
// agent view, the Claude tab's workspace comes to the front to show it.

import { Grid } from "@/engine";
import type { MonacoRange } from "../../../shared/editor/monaco-range";
import { ipcCallResult } from "../../ipc/client";
import { openBrowserTabAt, revealTab } from "../../state/operations/tabs";
import { isAgentViewShown, useAgentViewStore } from "../../state/stores/agent-view";
import { useLayoutStore } from "../../state/stores/layout/store";
import { revealInWorkspace } from "../agent-sessions/actions";
import { showInAgentView } from "../agent-view/show";
import { revealEditorAt } from "../editor/tabs";
import { openExternalEditor } from "../editor/tabs/open-external-editor";
import { requestEditorReveal } from "../editor/tabs/pending-reveal";
import { filesThere } from "./file-presence";
import { findLinkPlace, type LinkPlaceIndex, linkPlaces } from "./link-places";
import { type FileLink, isUnder, type LineAt } from "./links";

/**
 * Makes the group the new tab goes in the active one: the group next to
 * the Claude tab's; with `split`, a new one when there is none; otherwise
 * the Claude tab's own. From the agent view always a new one: how wide the
 * Claude tab is there says nothing of its group in the workspace, and the
 * conversation stays in sight beside what it opened.
 */
export function activateTarget(workspaceId: string, tabId: string, split: boolean): void {
  if (showWorkspaceOf(workspaceId, tabId)) split = true;
  const store = useLayoutStore.getState();
  store.ensureLayout(workspaceId);
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;
  const leaves = Grid.allLeaves(layout.root);
  const at = leaves.findIndex((leaf) => leaf.tabIds.includes(tabId));
  if (at < 0) return;
  const next = leaves[at + 1] ?? leaves[at - 1];
  if (next) store.setActiveGroup(workspaceId, next.id);
  // A new group becomes the active one.
  else if (split) store.splitGroup(workspaceId, leaves[at].id, "horizontal", "after");
  else store.setActiveGroup(workspaceId, leaves[at].id);
}

/**
 * Opens a file in the editor, with the cursor at `at` when it names a line;
 * one outside the workspace opens read-only.
 */
export function openFileBeside(
  workspaceId: string,
  claudeTabId: string,
  path: string,
  opts: { split: boolean; inside: boolean; at?: LineAt },
): void {
  activateTarget(workspaceId, claudeTabId, opts.split);
  openFile(workspaceId, path, opts);
}

/** Opens a file in the workspace's active group. */
function openFile(workspaceId: string, path: string, opts: { inside: boolean; at?: LineAt }): void {
  const range = opts.at?.line ? cursorAt(opts.at.line, opts.at.column) : undefined;
  if (opts.inside) {
    revealEditorAt({ workspaceId, filePath: path }, { preview: true, selection: range });
    return;
  }
  const { tabId } = openExternalEditor({ workspaceId, filePath: path });
  if (range) {
    requestEditorReveal({ workspaceId, filePath: path, origin: "external", range, tabId });
  }
}

export function cursorAt(line: number, column = 1): MonacoRange {
  return { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column };
}

/**
 * The file a link opens: one named with its `:12`, when the workspace has a
 * file of that name; otherwise the file before it, at that line.
 */
export async function fileLinkTarget(
  workspaceId: string,
  root: string,
  link: FileLink,
): Promise<FileLink> {
  const { literal } = link;
  if (!literal || !isUnder(literal, root)) return link;
  const relPath = literal.slice(root.replace(/\/+$/, "").length + 1);
  const stat = await ipcCallResult("fs", "stat", { workspaceId, relPath }).catch(() => null);
  return stat?.ok ? { path: literal } : link;
}

/**
 * The file a link a reply wrote opens: of the places it may name
 * (link-places), the first that is a file, in the workspace or granted
 * outside it, or the likeliest; then as fileLinkTarget picks it. Null for
 * a link to no file.
 */
export async function followFileLink(
  workspaceId: string,
  root: string,
  target: string,
  places: LinkPlaceIndex,
): Promise<FileLink | null> {
  const place = await findLinkPlace(linkPlaces(target, places), (paths) =>
    filesThere(workspaceId, root, paths),
  );
  return place && fileLinkTarget(workspaceId, root, place);
}

/**
 * Leaves the agent view for the chat's workspace and brings the chat to the front.
 * Returns whether the agent view was shown.
 */
export function showWorkspaceOf(workspaceId: string, tabId: string): boolean {
  if (!isAgentViewShown()) return false;
  revealInWorkspace({ workspaceId, tabId });
  useAgentViewStore.getState().setMode("workspace");
  return true;
}

/**
 * Shows a tab of the workspace, wherever it is in the layout; in the agent
 * view while it is up.
 */
export function revealTabById(workspaceId: string, tabId: string): void {
  if (isAgentViewShown()) {
    showInAgentView(workspaceId, tabId);
    return;
  }
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;
  const leaf = Grid.allLeaves(layout.root).find((l) => l.tabIds.includes(tabId));
  if (leaf) revealTab(workspaceId, leaf.id, tabId);
}

/** Opens an address in the app's browser. */
export function openBrowserBeside(
  workspaceId: string,
  claudeTabId: string,
  url: string,
  opts: { split: boolean },
): void {
  activateTarget(workspaceId, claudeTabId, opts.split);
  openBrowserTabAt(workspaceId, url);
}
