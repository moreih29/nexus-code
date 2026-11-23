import { create } from "zustand";
import {
  LIMIT_RESUME_DEFAULTS,
  type LimitResumeOptions,
} from "../../../shared/chat/limit-resume-settings";
import { ipcCallResult } from "../../ipc/client";

interface NotificationsState {
  osEnabled: boolean;
  rateLimitWarnings: boolean;
  limitResume: boolean;
  limitResumeOptions: LimitResumeOptions;
  dismissedRateLimits: ReadonlySet<string>;
  dismissedBanners: ReadonlyMap<string, string>;
  hydrate(
    state: Partial<LimitResumeOptions> & {
      osNotificationsEnabled?: boolean;
      rateLimitWarnings?: boolean;
      chatLimitResume?: boolean;
    },
  ): void;
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
