/**
 * Zustand-safe selectors for the files store selection model.
 *
 * All selectors that touch `selection.paths` return primitive types (boolean,
 * string | null, readonly string[]) so reference-comparison in useFilesStore()
 * hooks stays stable between renders. Never expose the raw `Set` or a new
 * object from a selector — Zustand's default Object.is comparison would cause
 * a re-render on every store write.
 */

import { distinctParents } from "../../../services/fs-mutations/distinct-parents";
import { getOperablePaths } from "./selection";
import type { FileSelection, FilesState } from "./types";

/** Return the FileSelection for a workspace, or a stable empty object. */
function getSelOrEmpty(state: FilesState, workspaceId: string): FileSelection {
  return state.selection.get(workspaceId) ?? { focus: null, anchor: null, paths: new Set() };
}

/** The focused path for a workspace, or null. */
export function selectFocus(state: FilesState, workspaceId: string): string | null {
  return getSelOrEmpty(state, workspaceId).focus;
}

/** Whether `path` is in the explicit selection set for `workspaceId`. */
export function selectIsSelected(state: FilesState, workspaceId: string, path: string): boolean {
  return getSelOrEmpty(state, workspaceId).paths.has(path);
}

/** Whether `path` is the keyboard focus for `workspaceId`. */
export function selectIsFocused(state: FilesState, workspaceId: string, path: string): boolean {
  return getSelOrEmpty(state, workspaceId).focus === path;
}

/**
 * Returns the operable paths for a workspace.
 *
 * If the selection set is non-empty: returns [...paths].
 * If the selection set is empty: returns [focus] (or [] when focus is null).
 *
 * The returned array is newly created on each call — do NOT use this in a
 * Zustand selector that triggers re-renders via reference comparison.  Use
 * `selectFocus` or `selectIsSelected` for per-row subscriptions.
 */
export function selectFocusedPaths(state: FilesState, workspaceId: string): readonly string[] {
  return getOperablePaths(getSelOrEmpty(state, workspaceId));
}

/**
 * Returns the set of paths that commands (delete, copy, cut) should operate on.
 *
 * Differs from `selectFocusedPaths` in that when `paths` is non-empty,
 * `distinctParents` is applied first — descendants are dropped so a command
 * does not double-operate on a parent and its child (VSCode fileActions.ts L97 parity).
 *
 *   - paths is empty and focus is set → [focus] (single row, no dedup needed).
 *   - paths is non-empty             → distinctParents([...paths]).
 *   - both are absent                → [].
 *
 * The returned array is freshly allocated on every call. Never use this in a
 * Zustand subscription that compares by reference.
 */
export function selectOperablePaths(state: FilesState, workspaceId: string): readonly string[] {
  const sel = getSelOrEmpty(state, workspaceId);
  if (sel.paths.size === 0) {
    return sel.focus !== null ? [sel.focus] : [];
  }
  return distinctParents([...sel.paths]);
}
