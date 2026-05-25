// src/renderer/state/stores/notifications.ts — OS notification preferences.
//
// Thin zustand store that mirrors the AppState `osNotificationsEnabled` field
// in the renderer so the Notifications panel can read and optimistically
// update it without prop drilling through App.tsx.
//
// Hydrated by `bootstrapAppState` after the first `appState.get` call.
// Persisted back to main via `appState.set` from the Notifications panel.

import { create } from "zustand";

interface NotificationsState {
  /** OS notifications master toggle. Defaults to true until hydrated. */
  osEnabled: boolean;
  /** Hydrate from persisted appState on bootstrap. */
  hydrate(osEnabled: boolean | undefined): void;
  /** Set toggle locally (component calls this for optimistic updates). */
  setOsEnabled(enabled: boolean): void;
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  osEnabled: true,

  hydrate(osEnabled) {
    set({ osEnabled: osEnabled ?? true });
  },

  setOsEnabled(osEnabled) {
    set({ osEnabled });
  },
}));
