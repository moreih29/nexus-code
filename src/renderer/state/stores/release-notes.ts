import { create } from "zustand";
import type { ReleaseNote, ReleaseNotesResult } from "../../../shared/updates/release-notes";

type FailureReason = Extract<ReleaseNotesResult, { kind: "error" }>["reason"];

interface ReleaseNotesState {
  open: boolean;
  wanted: string | null;
  openCount: number;
  notes: ReleaseNote[] | null;
  loading: boolean;
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
