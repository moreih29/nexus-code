/**
 * Pixel constants shared across the file-tree row, edit row, and the
 * virtualizer's `estimateSize`. These three must stay in lockstep — if
 * the row grows or shrinks visually the virtualizer needs to know, or
 * scroll positions drift.
 */

import { UI_LOADING_FLASH_DELAY_MS } from "../../../shared/timing-constants";

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
 * Delay before the loading indicator appears. Re-exported under a
 * file-tree-local name so existing call sites stay unchanged.
 * See `shared/timing-constants.ts` for the canonical definition.
 */
export const LOADING_FLASH_DELAY_MS = UI_LOADING_FLASH_DELAY_MS;
