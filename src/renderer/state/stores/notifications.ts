// src/renderer/state/stores/notifications.ts — notification preferences.
//
// Thin zustand store that mirrors the AppState `osNotificationsEnabled` and
// `rateLimitWarnings` fields in the renderer so the Notifications panel can
// read and optimistically update them without prop drilling through App.tsx.
// It also keeps which usage-limit warnings the user closed, for this run of
// the app (services/chat/rate-limit).
//
// Hydrated by `bootstrapAppState` after the first `appState.get` call.
// Persisted back to main via `appState.set` from the Notifications panel.

import { create } from "zustand";

interface NotificationsState {
  /** OS notifications master toggle. Defaults to true until hydrated. */
  osEnabled: boolean;
  /** Whether a near usage limit shows a warning in Claude tabs. */
  rateLimitWarnings: boolean;
  /** The usage-limit warnings closed, by services/chat/rate-limit's key. */
  dismissedRateLimits: ReadonlySet<string>;
  /** Hydrate from persisted appState on bootstrap. */
  hydrate(state: { osNotificationsEnabled?: boolean; rateLimitWarnings?: boolean }): void;
  /** Set toggle locally (component calls this for optimistic updates). */
  setOsEnabled(enabled: boolean): void;
  setRateLimitWarnings(enabled: boolean): void;
  dismissRateLimit(key: string): void;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  osEnabled: true,
  rateLimitWarnings: true,
  dismissedRateLimits: new Set(),

  hydrate(state) {
    set({
      osEnabled: state.osNotificationsEnabled ?? true,
      rateLimitWarnings: state.rateLimitWarnings ?? true,
    });
  },

  setOsEnabled(osEnabled) {
    set({ osEnabled });
  },

  setRateLimitWarnings(rateLimitWarnings) {
    set({ rateLimitWarnings });
  },

  dismissRateLimit(key) {
    const dismissed = get().dismissedRateLimits;
    if (dismissed.has(key)) return;
    set({ dismissedRateLimits: new Set([...dismissed, key]) });
  },
}));
