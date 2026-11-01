// src/renderer/state/stores/updates.ts — Update preferences UI state.
//
// Thin zustand store that mirrors the AppState `updateChannel` and
// `autoCheckForUpdates` fields in the renderer so the Settings panel can read
// and optimistically update them without prop drilling through App.tsx.
//
// Hydrated by `bootstrapAppState` after the first `appState.get` call.
// Persisted back to main via `appState.set` from the About panel.
//
// It also holds where an update stands, which the About panel shows: fed by
// the `updates.statusChanged` / `updates.progress` broadcasts and read once
// from `updates.getStatus` for what came before.

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
  /** The last check or the step of an update under way; null before any. */
  status: UpdateStatus | null;
  /** The download's progress while one runs. */
  progress: UpdateProgress | null;
  /** Hydrate from persisted appState on bootstrap. */
  hydrate(input: {
    channel: UpdateChannel | undefined;
    autoCheckEnabled: boolean | undefined;
  }): void;
  /** Set channel locally (component calls this for optimistic updates). */
  setChannel(channel: UpdateChannel): void;
  /** Set auto-check toggle locally (component calls this for optimistic updates). */
  setAutoCheckEnabled(enabled: boolean): void;
  /** Takes a status from main. */
  applyStatus(status: UpdateStatus): void;
  /** Takes the download's progress from main. */
  applyProgress(progress: UpdateProgress): void;
}

export const useUpdatesStore = create<UpdatesState>((set) => ({
  channel: "stable",
  autoCheckEnabled: true,
  status: null,
  progress: null,

  hydrate({ channel, autoCheckEnabled }) {
    set({
      channel: channel ?? "stable",
      autoCheckEnabled: autoCheckEnabled ?? true,
    });
  },

  setChannel(channel) {
    set({ channel });
  },

  setAutoCheckEnabled(autoCheckEnabled) {
    set({ autoCheckEnabled });
  },

  applyStatus(next) {
    set((state) => {
      const status = nextUpdateStatus(state.status, next);
      return { status, progress: status?.kind === "downloading" ? state.progress : null };
    });
  },

  applyProgress(progress) {
    set((state) =>
      state.status?.kind === "downloading" && state.status.version === progress.version
        ? { progress }
        : {},
    );
  },
}));
