import { create } from "zustand";
import type { LspServerStatus } from "../../../shared/lsp/status";

export interface LspProgress {
  title?: string;
  message?: string;
  percentage?: number;
}

interface LspStatusState {
  statuses: Record<string, LspServerStatus>;
  progress: Record<string, LspProgress>;
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

export function isLspServerBusy(workspaceId: string, languageId: string): boolean {
  const key = lspStatusKey(workspaceId, languageId);
  const { statuses, progress } = useLspStatusStore.getState();
  return statuses[key]?.state === "starting" || progress[key] !== undefined;
}
