import { create } from "zustand";
import {
  nextUpdateStatus,
  type UpdateProgress,
  type UpdateStatus,
} from "../../../shared/updates/status";

type UpdateChannel = "stable" | "beta";

interface UpdatesState {
  channel: UpdateChannel;
  autoCheckEnabled: boolean;
  ignoredVersion: string | null;
  announcedVersion: string | null;
  status: UpdateStatus | null;
  progress: UpdateProgress | null;
  checking: boolean;
  hydrate(input: {
    channel: UpdateChannel | undefined;
    autoCheckEnabled: boolean | undefined;
    ignoredVersion?: string | null;
    announcedVersion?: string | null;
  }): void;
  setChannel(channel: UpdateChannel): void;
  setAutoCheckEnabled(enabled: boolean): void;
  setIgnoredVersion(version: string | null): void;
  setAnnouncedVersion(version: string | null): void;
  applyStatus(status: UpdateStatus): void;
  applyProgress(progress: UpdateProgress): void;
  restoreStatus(status: UpdateStatus | null): void;
  endCheck(): void;
}

export const useUpdatesStore = create<UpdatesState>((set) => ({
  channel: "stable",
  autoCheckEnabled: true,
  ignoredVersion: null,
  announcedVersion: null,
  status: null,
  progress: null,
  checking: false,

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
      return {
        status,
        progress: status?.kind === "downloading" ? state.progress : null,
        checking: next.kind === "checking",
      };
    });
  },

  endCheck() {
    set({ checking: false });
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
