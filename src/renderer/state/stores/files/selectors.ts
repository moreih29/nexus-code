import { distinctParents } from "../../../services/fs-mutations/distinct-parents";
import { getOperablePaths } from "./selection";
import type { FileSelection, FilesState } from "./types";

function getSelOrEmpty(state: FilesState, workspaceId: string): FileSelection {
  return state.selection.get(workspaceId) ?? { focus: null, anchor: null, paths: new Set() };
}

export function selectFocus(state: FilesState, workspaceId: string): string | null {
  return getSelOrEmpty(state, workspaceId).focus;
}

export function selectIsSelected(state: FilesState, workspaceId: string, path: string): boolean {
  return getSelOrEmpty(state, workspaceId).paths.has(path);
}

export function selectIsFocused(state: FilesState, workspaceId: string, path: string): boolean {
  return getSelOrEmpty(state, workspaceId).focus === path;
}

export function selectFocusedPaths(state: FilesState, workspaceId: string): readonly string[] {
  return getOperablePaths(getSelOrEmpty(state, workspaceId));
}

export function selectOperablePaths(state: FilesState, workspaceId: string): readonly string[] {
  const sel = getSelOrEmpty(state, workspaceId);
  if (sel.paths.size === 0) {
    return sel.focus !== null ? [sel.focus] : [];
  }
  return distinctParents([...sel.paths]);
}
