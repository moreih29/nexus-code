/**
 * The release notes view: opened from the title bar, Settings › About, the
 * update's popover and the app menu, over the panels. Each opening reads
 * the notes again (a 304 while GitHub has nothing new) and counts the
 * running version's notes as seen, which takes the title bar's "what's
 * new" away.
 */

import type { ReleaseNotesResult } from "../../../shared/updates/release-notes";
import { ipcCallResult } from "../../ipc/client";
import { useReleaseNotesStore } from "../stores/release-notes";
import { useSettingsUIStore } from "../stores/settings-ui";

/** Opens the view on `version`'s notes, or the running version's. */
export function showReleaseNotes(version: string | null = null): void {
  // The view shows over the panels, not over Settings.
  useSettingsUIStore.getState().closeSettings();
  useReleaseNotesStore.getState().show(version);
  markReleaseNotesSeen();
  void loadReleaseNotes();
}

export function closeReleaseNotes(): void {
  useReleaseNotesStore.getState().close();
}

/** Reads the notes, unless a read is under way. */
export async function loadReleaseNotes(): Promise<void> {
  const store = useReleaseNotesStore.getState();
  if (store.loading) return;
  store.startLoading();
  let result: ReleaseNotesResult = { kind: "error", reason: "unexpected" };
  try {
    const answer = await ipcCallResult("updates", "releaseNotes", undefined);
    if (answer.ok) result = answer.value;
  } catch {
    // Told as "unexpected", with a retry.
  }
  useReleaseNotesStore.getState().finishLoading(result);
}

/** Counts the running version's notes as seen. */
export function markReleaseNotesSeen(): void {
  const store = useReleaseNotesStore.getState();
  if (store.lastSeenVersion === __APP_VERSION__) return;
  store.setLastSeenVersion(__APP_VERSION__);
  void ipcCallResult("appState", "set", { lastSeenReleaseNotesVersion: __APP_VERSION__ });
}

/**
 * Takes the version last seen from AppState. The first launch that finds
 * none takes the running version as seen: a fresh install, or the update
 * that brought this view, has no "what's new" to offer.
 */
export function hydrateReleaseNotesSeen(lastSeen: string | null): void {
  if (lastSeen === null) markReleaseNotesSeen();
  else useReleaseNotesStore.getState().setLastSeenVersion(lastSeen);
}
