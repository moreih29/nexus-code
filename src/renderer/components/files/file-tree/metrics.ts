import { UI_LOADING_FLASH_DELAY_MS } from "../../../../shared/util/timing-constants";

export const ROW_HEIGHT_PX = 24;
export const INDENT_STEP_PX = 12;
const INDENT_BASE_PX = 8;

export function indentPaddingLeft(depth: number): number {
  return depth * INDENT_STEP_PX + INDENT_BASE_PX;
}

export const LOADING_FLASH_DELAY_MS = UI_LOADING_FLASH_DELAY_MS;
