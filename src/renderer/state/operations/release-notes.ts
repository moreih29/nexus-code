import type { ReleaseNotesResult } from "../../../shared/updates/release-notes";
import { ipcCallResult } from "../../ipc/client";
import { useReleaseNotesStore } from "../stores/release-notes";
import { useSettingsUIStore } from "../stores/settings-ui";

export function showReleaseNotes(version: string | null = null): void {
  useSettingsUIStore.getState().closeSettings();
  useReleaseNotesStore.getState().show(version);
  markReleaseNotesSeen();
  void loadReleaseNotes();
}

export function closeReleaseNotes(): void {
  useReleaseNotesStore.getState().close();
}

export function openReleasePage(url: string): void {
  if (url.startsWith("https://")) void ipcCallResult("updates", "openReleasePage", { url });
}

export async function loadReleaseNotes(): Promise<void> {
  const store = useReleaseNotesStore.getState();
  if (store.loading) return;
  store.startLoading();
  let result: ReleaseNotesResult = { kind: "error", reason: "unexpected" };
  try {
    const answer = await ipcCallResult("updates", "releaseNotes", undefined);
    if (answer.ok) result = answer.value;
  } catch {}
  useReleaseNotesStore.getState().finishLoading(result);
}

export function markReleaseNotesSeen(): void {
  const store = useReleaseNotesStore.getState();
  if (store.lastSeenVersion === __APP_VERSION__) return;
  store.setLastSeenVersion(__APP_VERSION__);
  void ipcCallResult("appState", "set", { lastSeenReleaseNotesVersion: __APP_VERSION__ });
}

export function hydrateReleaseNotesSeen(lastSeen: string | null): void {
  if (lastSeen === null) markReleaseNotesSeen();
  else useReleaseNotesStore.getState().setLastSeenVersion(lastSeen);
}
