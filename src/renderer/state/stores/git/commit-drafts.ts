/**
 * Commit message drafts, kept outside GitSession.
 *
 * The draft changes on every keystroke. Stored on the session, it gave the
 * session a new identity per keystroke and re-rendered everything that
 * subscribes to the whole session: every editor (conflict check), every tab
 * (decoration maps are cached per session), the file tree and the status
 * bar. Only the git panel needs the text.
 */
import { create } from "zustand";

interface CommitDraftState {
  drafts: ReadonlyMap<string, string>;
}

export const useCommitDraftStore = create<CommitDraftState>(() => ({ drafts: new Map() }));

/** Subscribes to one workspace's commit draft. */
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
