import { create } from "zustand";

interface CommitDraftState {
  drafts: ReadonlyMap<string, string>;
}

export const useCommitDraftStore = create<CommitDraftState>(() => ({ drafts: new Map() }));

export function useCommitDraft(workspaceId: string): string {
  return useCommitDraftStore((s) => s.drafts.get(workspaceId) ?? "");
}

export function getCommitDraft(workspaceId: string): string {
  return useCommitDraftStore.getState().drafts.get(workspaceId) ?? "";
}

export function setCommitDraftText(workspaceId: string, text: string): void {
  useCommitDraftStore.setState((state) => {
    if (state.drafts.get(workspaceId) === text) return state;
    const drafts = new Map(state.drafts);
    drafts.set(workspaceId, text);
    return { drafts };
  });
}

export function deleteCommitDraft(workspaceId: string): void {
  useCommitDraftStore.setState((state) => {
    if (!state.drafts.has(workspaceId)) return state;
    const drafts = new Map(state.drafts);
    drafts.delete(workspaceId);
    return { drafts };
  });
}
