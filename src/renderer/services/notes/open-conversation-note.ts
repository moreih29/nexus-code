import type { LinkedNote } from "../../../shared/types/notes";
import { findNoteTab, openOrRevealNoteTab } from "../../state/operations/tabs";
import { useLayoutStore } from "../../state/stores/layout/store";
import { activateTarget, showWorkspaceOf } from "../chat/open-beside";
import { groupOf } from "../cli/placement";

/** Leaves the chat visible in its own workspace, including when it belongs to a task. */
export function openConversationNote(workspaceId: string, tabId: string, note: LinkedNote): void {
  const chatGroup = groupOf(workspaceId, tabId);
  if (!chatGroup) return;
  showWorkspaceOf(workspaceId, tabId);
  const existing = findNoteTab(workspaceId, note.noteId);
  if (!existing || existing.groupId === chatGroup) {
    activateTarget(workspaceId, tabId, true);
    const layout = useLayoutStore.getState();
    const group = layout.byWorkspace[workspaceId]?.activeGroupId;
    if (existing && group && group !== chatGroup)
      layout.moveTab(workspaceId, existing.tabId, group);
  }
  openOrRevealNoteTab(workspaceId, note.noteId, note.title);
}
