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
  else if (split) store.splitGroup(workspaceId, leaves[at].id, "horizontal", "after");
  else store.setActiveGroup(workspaceId, leaves[at].id);
}

export function openFileBeside(
  workspaceId: string,
  claudeTabId: string,
  path: string,
  opts: { split: boolean; inside: boolean; at?: LineAt },
): void {
  activateTarget(workspaceId, claudeTabId, opts.split);
  openFile(workspaceId, path, opts);
}

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

export function showWorkspaceOf(workspaceId: string, tabId: string): boolean {
  if (!isAgentViewShown()) return false;
  revealInWorkspace({ workspaceId, tabId });
  useAgentViewStore.getState().setMode("workspace");
  return true;
}

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

export function openBrowserBeside(
  workspaceId: string,
  claudeTabId: string,
  url: string,
  opts: { split: boolean },
): void {
  activateTarget(workspaceId, claudeTabId, opts.split);
  openBrowserTabAt(workspaceId, url);
}
