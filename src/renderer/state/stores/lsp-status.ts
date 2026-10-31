// Each language server's status, mirrored from main (lsp:serverStatus), and
// the work it reports through $/progress (services/lsp-ux/server-ux-router).
// The status bar and the hover read it.

import { create } from "zustand";
import type { LspServerStatus } from "../../../shared/lsp/status";

export interface LspProgress {
  title?: string;
  message?: string;
  percentage?: number;
}

interface LspStatusState {
  /** Keyed by lspStatusKey. */
  statuses: Record<string, LspServerStatus>;
  /** The work a server reports, until it ends. Keyed by lspStatusKey. */
  progress: Record<string, LspProgress>;
  /** Main's statuses at launch; one broadcast since stays. */
  hydrate(statuses: LspServerStatus[]): void;
  setStatus(status: LspServerStatus): void;
  setProgress(workspaceId: string, languageId: string, progress: LspProgress | null): void;
  forgetWorkspace(workspaceId: string): void;
}

export function lspStatusKey(workspaceId: string, languageId: string): string {
  return `${workspaceId}\0${languageId}`;
}

function withoutWorkspace<T>(record: Record<string, T>, workspaceId: string): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith(`${workspaceId}\0`)),
  );
}

export const useLspStatusStore = create<LspStatusState>((set) => ({
  statuses: {},
  progress: {},

  hydrate(statuses) {
    // A status broadcast while the list was on its way is newer.
    set((s) => ({
      statuses: {
        ...Object.fromEntries(
          statuses.map((status) => [lspStatusKey(status.workspaceId, status.languageId), status]),
        ),
        ...s.statuses,
      },
    }));
  },

  setStatus(status) {
    const key = lspStatusKey(status.workspaceId, status.languageId);
    set((s) => {
      // A stopped server reports nothing more; work it left unfinished ends.
      const { [key]: _ended, ...progress } = s.progress;
      return {
        statuses: { ...s.statuses, [key]: status },
        ...(status.state === "running" ? {} : { progress }),
      };
    });
  },

  setProgress(workspaceId, languageId, next) {
    const key = lspStatusKey(workspaceId, languageId);
    set((s) => {
      const { [key]: _previous, ...progress } = s.progress;
      return { progress: next ? { ...progress, [key]: next } : progress };
    });
  },

  forgetWorkspace(workspaceId) {
    set((s) => ({
      statuses: withoutWorkspace(s.statuses, workspaceId),
      progress: withoutWorkspace(s.progress, workspaceId),
    }));
  },
}));

/** Whether the server is not ready to answer yet: starting, or loading. */
export function isLspServerBusy(workspaceId: string, languageId: string): boolean {
  const key = lspStatusKey(workspaceId, languageId);
  const { statuses, progress } = useLspStatusStore.getState();
  return statuses[key]?.state === "starting" || progress[key] !== undefined;
}
