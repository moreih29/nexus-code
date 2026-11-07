// src/renderer/state/stores/release-notes.ts — the release notes view.
//
// Whether the view is open over the panels and which release it shows, the
// notes last read from GitHub (kept while a newer read is under way), and
// the version whose notes the user last saw, mirrored from AppState
// `lastSeenReleaseNotesVersion` for the title bar.

import { create } from "zustand";
import type { ReleaseNote, ReleaseNotesResult } from "../../../shared/updates/release-notes";

type FailureReason = Extract<ReleaseNotesResult, { kind: "error" }>["reason"];

interface ReleaseNotesState {
  open: boolean;
  /** The version asked for; null shows the running version's notes. */
  wanted: string | null;
  /** Counts the openings, so one while the view is open takes the focus to it. */
  openCount: number;
  /** The notes last read, newest first; null before the first read. */
  notes: ReleaseNote[] | null;
  loading: boolean;
  /** Why the last read failed; null once one succeeds. */
  error: FailureReason | null;
  lastSeenVersion: string | null;

  show(wanted: string | null): void;
  close(): void;
  select(version: string): void;
  startLoading(): void;
  finishLoading(result: ReleaseNotesResult): void;
  setLastSeenVersion(version: string | null): void;
}

export const useReleaseNotesStore = create<ReleaseNotesState>((set) => ({
  open: false,
  wanted: null,
  openCount: 0,
  notes: null,
  loading: false,
  error: null,
  lastSeenVersion: null,

  show(wanted) {
    set((s) => ({ open: true, wanted, openCount: s.openCount + 1 }));
  },
  close() {
    set({ open: false });
  },
  select(version) {
    set({ wanted: version });
  },
  startLoading() {
    set({ loading: true });
  },
  finishLoading(result) {
    set(
      result.kind === "ok"
        ? { loading: false, notes: result.notes, error: null }
        : { loading: false, error: result.reason },
    );
  },
  setLastSeenVersion(lastSeenVersion) {
    set({ lastSeenVersion });
  },
}));
