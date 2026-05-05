/**
 * Pixel constants shared across the file-tree row, edit row, and the
 * virtualizer's `estimateSize`. These three must stay in lockstep — if
 * the row grows or shrinks visually the virtualizer needs to know, or
 * scroll positions drift.
 */

export const ROW_HEIGHT_PX = 24;
export const INDENT_STEP_PX = 12;
export const INDENT_BASE_PX = 8;

/**
 * Left padding for a row at the given depth. Used by both the regular
 * row and the inline-create edit row so the input lines up under its
 * sibling rows pixel-perfectly.
 */
export function indentPaddingLeft(depth: number): number {
  return depth * INDENT_STEP_PX + INDENT_BASE_PX;
}

/**
 * Delay before the loading indicator appears. Below this threshold
 * fast IPC round-trips finish without ever flashing the spinner —
 * matches the well-known "skeleton vs flash" UX threshold.
 */
export const LOADING_FLASH_DELAY_MS = 200;
