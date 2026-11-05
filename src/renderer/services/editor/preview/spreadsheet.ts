/**
 * Spreadsheet files (.xlsx, .xlsm) as the preview shows them: sheets of
 * cells, by row and column. Reading one is in ./xlsx, which is loaded only
 * when a spreadsheet is opened.
 */

export function isSpreadsheetFile(filePath: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(filePath);
}

export interface SheetCell {
  readonly text: string;
  /** Whether it holds a number (a date included), which lines up at the right. */
  readonly numeric: boolean;
}

export interface Sheet {
  readonly name: string;
  /** Rows by index, row 1 first; a row with no values is not there. */
  readonly rows: readonly (readonly (SheetCell | undefined)[] | undefined)[];
  /** Columns up to the last that has a value, within `MAX_SHEET_COLUMNS`. */
  readonly columns: number;
  /** Each column's width in characters: the file's own, or else its text's. */
  readonly widths: readonly number[];
  /** Whether it had values past `MAX_SHEET_COLUMNS`, which are left out. */
  readonly clipped: boolean;
  /** A sheet that is a chart, which has no cells. */
  readonly chart: boolean;
}

export interface Workbook {
  readonly sheets: readonly Sheet[];
}

/** The widest a sheet shows; a value further right is left out. */
export const MAX_SHEET_COLUMNS = 500;

/** A1-style reference to zero-based row and column; null if it is not one. */
export function cellPosition(ref: string): { row: number; column: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
  if (!m) return null;
  let column = 0;
  for (const letter of (m[1] as string).toUpperCase())
    column = column * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(m[2]) - 1, column: column - 1 };
}

/** The letters of the zero-based `column`: A, B, …, Z, AA, … */
export function columnName(column: number): string {
  let name = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}
