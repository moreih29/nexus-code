/**
 * Shared types for the in-editor "dirty diff" feature — VSCode-style gutter
 * markers that show, line-by-line, what changed in the current buffer relative
 * to the git baseline (HEAD), plus a click-to-open inline peek of the change.
 *
 * The model compares the *live editor buffer* against the HEAD blob, so markers
 * update as the user types (before save) — matching VSCode's behaviour. This is
 * why diffing happens in the renderer against the in-memory model rather than
 * shelling out to `git diff` (which only sees on-disk content).
 */

/** Classification of a single contiguous change region. */
export type DirtyChangeType = "add" | "modify" | "delete";

/**
 * One contiguous change between the HEAD baseline and the current buffer.
 *
 * Line numbers are 1-based and inclusive on the `*Start`/`*End` fields, matching
 * Monaco's range conventions. For pure deletions there is no modified content,
 * so `modifiedStartLineNumber === modifiedEndLineNumber` marks the line *after*
 * which the deleted lines used to sit.
 */
export interface DirtyChange {
  type: DirtyChangeType;
  /** 1-based inclusive start line in the HEAD baseline document. */
  originalStartLineNumber: number;
  /** 1-based inclusive end line in the HEAD baseline document. 0 when empty. */
  originalEndLineNumber: number;
  /** 1-based inclusive start line in the current buffer. */
  modifiedStartLineNumber: number;
  /** 1-based inclusive end line in the current buffer. 0 when empty (deletion). */
  modifiedEndLineNumber: number;
}
