// The column widths of a DataGrid, as a CSS grid template.
//
// A column's width is its content width, in characters, plus what the cell
// puts around the content. Without that the longest value of a column does not
// fit and is cut with an ellipsis.

/** A field cell's left and right padding (Tailwind `px-2`), in px. */
export const FIELD_PADDING_PX = 16;
/** A field cell's left border (`border-l`), in px. */
export const FIELD_BORDER_PX = 1;
/** What a field cell has around its content, in px: padding and border. */
export const FIELD_CHROME_PX = FIELD_PADDING_PX + FIELD_BORDER_PX;
/** The row-number cell's left and right padding (Tailwind `px-1`), in px. */
export const GUTTER_PADDING_PX = 8;

/** The row-number column's width: its digits (at least 2) and the cell's padding. */
export function gutterTrack(rowCount: number): string {
  const digits = Math.max(2, String(rowCount).length);
  return `calc(${digits}ch + ${GUTTER_PADDING_PX}px)`;
}

/** A field column's width, for content `chars` characters wide. */
export function fieldTrack(chars: number): string {
  return `calc(${chars}ch + ${FIELD_CHROME_PX}px)`;
}

/** The grid template of a row: the row numbers, then the columns. */
export function gridTemplate(rowCount: number, widths: readonly number[]): string {
  return [gutterTrack(rowCount), ...widths.map(fieldTrack)].join(" ");
}
