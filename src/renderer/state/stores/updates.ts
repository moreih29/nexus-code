// src/renderer/state/stores/updates.ts — Update preferences UI state.
//
// Thin zustand store that mirrors the AppState `updateChannel` and
// `autoCheckForUpdates` fields in the renderer so the Settings panel can read
// and optimistically update them without prop drilling through App.tsx.
//
// Hydrated by `bootstrapAppState` after the first `appState.get` call.
// Persisted back to main via `appState.set` from the About panel.
//
// It also holds where an update stands, which the About panel and the title
// bar's update button show: fed by the `updates.statusChanged` /
// `updates.progress` broadcasts and read once from `updates.getStatus` for
// what came before. And the versions the user skipped and was told of, so
// the button and the toast leave those be.

import { create } from "zustand";
import {
  nextUpdateStatus,
  type UpdateProgress,
  type UpdateStatus,
} from "../../../shared/updates/status";

type UpdateChannel = "stable" | "beta";

interface UpdatesState {
  /** Current update channel. Defaults to "stable" until hydrated from appState. */
  channel: UpdateChannel;
  /** Auto-check toggle. Defaults to true until hydrated from appState. */
  autoCheckEnabled: boolean;
  /** The version the user chose to skip, which the title bar does not offer. */
  ignoredVersion: string | null;
  /** The newer version a toast last told the user of. */
  announcedVersion: string | null;
  /** The last check or the step of an update under way; null before any. */
  status: UpdateStatus | null;
  /** The download's progress while one runs. */
  progress: UpdateProgress | null;
  /** Hydrate from persisted appState on bootstrap. */
  hydrate(input: {
    channel: UpdateChannel | undefined;
    autoCheckEnabled: boolean | undefined;
    ignoredVersion?: string | null;
    announcedVersion?: string | null;
  }): void;
  /** Set channel locally (component calls this for optimistic updates). */
  setChannel(channel: UpdateChannel): void;
  /** Set auto-check toggle locally (component calls this for optimistic updates). */
  setAutoCheckEnabled(enabled: boolean): void;
  setIgnoredVersion(version: string | null): void;
  setAnnouncedVersion(version: string | null): void;
  /** Takes a status from main. */
  applyStatus(status: UpdateStatus): void;
  /** Takes the download's progress from main. */
  applyProgress(progress: UpdateProgress): void;
  /** Puts back the status shown before an update that did not start. */
  restoreStatus(status: UpdateStatus | null): void;
}

export const useUpdatesStore = create<UpdatesState>((set) => ({
  channel: "stable",
  autoCheckEnabled: true,
  ignoredVersion: null,
  announcedVersion: null,
  status: null,
  progress: null,

  hydrate({ channel, autoCheckEnabled, ignoredVersion, announcedVersion }) {
    set({
      channel: channel ?? "stable",
      autoCheckEnabled: autoCheckEnabled ?? true,
      ignoredVersion: ignoredVersion ?? null,
      announcedVersion: announcedVersion ?? null,
    });
  },

  setChannel(channel) {
    set({ channel });
  },

  setAutoCheckEnabled(autoCheckEnabled) {
    set({ autoCheckEnabled });
  },

  setIgnoredVersion(ignoredVersion) {
    set({ ignoredVersion });
  },

  setAnnouncedVersion(announcedVersion) {
    set({ announcedVersion });
  },

  applyStatus(next) {
    set((state) => {
      const status = nextUpdateStatus(state.status, next);
      return { status, progress: status?.kind === "downloading" ? state.progress : null };
    });
  },

  restoreStatus(status) {
    set({ status, progress: null });
  },

  applyProgress(progress) {
    set((state) =>
      state.status?.kind === "downloading" && state.status.version === progress.version
        ? { progress }
        : {},
    );
  },
}));
