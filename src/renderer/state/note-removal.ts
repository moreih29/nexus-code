// Renderer-wide handling of notes removed while tabs show them.

import { notesApi } from "../services/notes/api";
import { closeNoteTabs } from "./operations";
import { useTabsStore } from "./stores/tabs";

/**
 * Installs the app-wide listener that closes the tabs of removed notes.
 * Call once from bootstrap; returns the unlisten function.
 *
 * A note can be removed from its own tab, from Settings › Notes (all of a
 * location's notes at once) or from another window; a tab of it, mounted or
 * not, would otherwise stay open on a note that is gone.
 */
export function startNoteRemovalListener(): () => void {
  return notesApi.onChanged((event) => {
    if (event.change !== "removed") return;
    const byWorkspace = useTabsStore.getState().byWorkspace;
    for (const [workspaceId, tabs] of Object.entries(byWorkspace)) {
      for (const tab of Object.values(tabs ?? {})) {
        if (tab.type !== "note") continue;
        const { noteId } = tab.props;
        if (event.noteId) {
          if (noteId === event.noteId) closeNoteTabs(workspaceId, noteId);
          continue;
        }
        // A whole location's notes: close the tabs whose note is no longer there.
        notesApi.read(workspaceId, noteId).catch(() => closeNoteTabs(workspaceId, noteId));
      }
    }
  });
}
