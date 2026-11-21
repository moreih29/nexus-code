// src/renderer/state/stores/notifications.ts — notification preferences.
//
// Thin zustand store that mirrors the AppState `osNotificationsEnabled` and
// `rateLimitWarnings` fields in the renderer so the Notifications panel can
// read and optimistically update them without prop drilling through App.tsx,
// and `chatLimitResume`, the other usage-limit preference (Settings › Agents).
// It also keeps which usage-limit warnings the user closed, for this run of
// the app (services/chat/rate-limit).
//
// Hydrated by `bootstrapAppState` after the first `appState.get` call.
// Persisted back to main via `appState.set` from the Notifications panel.

import { create } from "zustand";
import {
  LIMIT_RESUME_DEFAULTS,
  type LimitResumeOptions,
} from "../../../shared/chat/limit-resume-settings";
import { ipcCallResult } from "../../ipc/client";

interface NotificationsState {
  /** OS notifications master toggle. Defaults to true until hydrated. */
  osEnabled: boolean;
  /** Whether a near usage limit shows a warning in Claude tabs. */
  rateLimitWarnings: boolean;
  /** Whether a chat tab goes on by itself once the plan's usage limit resets. */
  limitResume: boolean;
  limitResumeOptions: LimitResumeOptions;
  /** The usage-limit warnings closed, by services/chat/rate-limit's key. */
  dismissedRateLimits: ReadonlySet<string>;
  /** The latest dismissed situation for each banner, kept in this renderer. */
  dismissedBanners: ReadonlyMap<string, string>;
  /** Hydrate from persisted appState on bootstrap. */
  hydrate(
    state: Partial<LimitResumeOptions> & {
      osNotificationsEnabled?: boolean;
      rateLimitWarnings?: boolean;
      chatLimitResume?: boolean;
    },
  ): void;
  /** Set toggle locally (component calls this for optimistic updates). */
  setOsEnabled(enabled: boolean): void;
  setRateLimitWarnings(enabled: boolean): void;
  setLimitResume(enabled: boolean): void;
  setLimitResumeOptions(patch: Partial<LimitResumeOptions>): void;
  dismissRateLimit(key: string): void;
  dismissBanner(scope: string, situation: string): void;
  resetBannerDismissal(scope: string, situation: string): void;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  osEnabled: true,
  rateLimitWarnings: true,
  limitResume: true,
  limitResumeOptions: LIMIT_RESUME_DEFAULTS,
  dismissedRateLimits: new Set(),
  dismissedBanners: new Map(),

  hydrate(state) {
    const {
      chatLimitResumeDelayMinutes = LIMIT_RESUME_DEFAULTS.chatLimitResumeDelayMinutes,
      chatLimitResumeMaxTries = LIMIT_RESUME_DEFAULTS.chatLimitResumeMaxTries,
      chatLimitResumeDeadlineHours = LIMIT_RESUME_DEFAULTS.chatLimitResumeDeadlineHours,
      chatLimitResumeMessage = LIMIT_RESUME_DEFAULTS.chatLimitResumeMessage,
    } = state;
    set({
      osEnabled: state.osNotificationsEnabled ?? true,
      rateLimitWarnings: state.rateLimitWarnings ?? true,
      limitResume: state.chatLimitResume ?? true,
      limitResumeOptions: {
        chatLimitResumeDelayMinutes,
        chatLimitResumeMaxTries,
        chatLimitResumeDeadlineHours,
        chatLimitResumeMessage,
      },
    });
  },

  setOsEnabled(osEnabled) {
    set({ osEnabled });
  },

  setRateLimitWarnings(rateLimitWarnings) {
    set({ rateLimitWarnings });
  },

  setLimitResume(limitResume) {
    set({ limitResume });
  },

  setLimitResumeOptions(patch) {
    set((state) => ({ limitResumeOptions: { ...state.limitResumeOptions, ...patch } }));
    void ipcCallResult("appState", "set", patch);
  },

  dismissRateLimit(key) {
    const dismissed = get().dismissedRateLimits;
    if (dismissed.has(key)) return;
    set({ dismissedRateLimits: new Set([...dismissed, key]) });
  },

  dismissBanner(scope, situation) {
    set({ dismissedBanners: new Map(get().dismissedBanners).set(scope, situation) });
  },

  resetBannerDismissal(scope, situation) {
    const dismissed = get().dismissedBanners;
    if (dismissed.get(scope) !== situation) return;
    const next = new Map(dismissed);
    next.delete(scope);
    set({ dismissedBanners: next });
  },
}));
