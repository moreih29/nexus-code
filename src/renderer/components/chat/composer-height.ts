// How tall the composer's text box may grow before it scrolls: 240px, or in
// a tall tab up to 30% of the column the composer sits in. Pure, for the
// composer and its tests.

/** The cap in any tab, however short. */
export const MAX_TEXT_PX = 240;
/** How much of a tall tab's column the text box may take. */
export const MAX_TEXT_SHARE = 0.3;

/** The text box's cap in a column `columnHeight` pixels tall. */
export function maxTextHeight(columnHeight: number): number {
  return Math.max(MAX_TEXT_PX, Math.floor(columnHeight * MAX_TEXT_SHARE));
}
