import { type RemoteFileRef, remoteFileKey } from "../../../shared/fs/remote-file-key";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useTabsStore } from "../../state/stores/tabs";
import { sessionKey } from "../agent-sessions/model";
import type { LineAt } from "../chat/links";
import { cursorAt } from "../chat/open-beside";
import { findEditorTab, openOrRevealEditor } from "../editor/tabs";
import { requestEditorReveal } from "../editor/tabs/pending-reveal";
import { requestTabFocus } from "../tab-focus";
import { leafHolding, leafShowing, selectHeldKey, showBeside } from "./layout";

export function showHeldLocalFile(workspaceId: string, path: string, at?: LineAt): boolean {
  const view = useAgentViewStore.getState();
  if (view.mode !== "agents") return false;
  const existing = findEditorTab(
    workspaceId,
    path,
    (id) => leafHolding(view.root, sessionKey(workspaceId, id)) !== null,
  );
  if (!existing) return false;
  const key = sessionKey(workspaceId, existing.tabId);
  view.update((layout) => selectHeldKey(layout, key) ?? layout);
  revealLocalFile(workspaceId, existing.tabId, at);
  return true;
}

export function placeLocalFile(
  workspaceId: string,
  fromTabId: string,
  path: string,
  inside: boolean,
  at?: LineAt,
): void {
  const view = useAgentViewStore.getState();
  const fromLeaf = leafShowing(view.root, sessionKey(workspaceId, fromTabId));
  if (view.mode !== "agents" || fromLeaf === null) return;
  if (showHeldLocalFile(workspaceId, path, at)) return;
  const { tabId } =
    findEditorTab(workspaceId, path) ??
    openOrRevealEditor(
      { workspaceId, filePath: path, ...(inside ? {} : { origin: "external", readOnly: true }) },
      { preview: false },
    );
  useTabsStore.getState().promoteFromPreview(workspaceId, tabId);
  view.update((layout) => showBeside(layout, sessionKey(workspaceId, tabId), fromLeaf));
  revealLocalFile(workspaceId, tabId, at);
}

function revealLocalFile(workspaceId: string, tabId: string, at?: LineAt): void {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type !== "editor") return;
  if (at?.line) {
    requestEditorReveal({
      ...tab.props,
      range: cursorAt(at.line, at.column),
      tabId,
      preserveFocus: true,
    });
  }
  requestTabFocus(tabId);
}

export function showHeldRemoteFile(file: RemoteFileRef, at?: LineAt): boolean {
  const view = useAgentViewStore.getState();
  const key = remoteFileKey(file);
  if (view.mode !== "agents" || !view.remoteFiles.has(key) || !leafHolding(view.root, key)) {
    return false;
  }
  if (at?.line) {
    view.updateRemoteFile(key, {
      at: { line: at.line, column: at.column },
      mode: "raw",
      compare: false,
    });
  }
  view.update((layout) => selectHeldKey(layout, key) ?? layout);
  requestTabFocus(key);
  return true;
}
