export function isSpreadsheetFile(filePath: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(filePath);
}

export interface SheetCell {
  readonly text: string;
  readonly numeric: boolean;
}

export interface Sheet {
  readonly name: string;
  readonly rows: readonly (readonly (SheetCell | undefined)[] | undefined)[];
  readonly columns: number;
  readonly widths: readonly number[];
  readonly clipped: boolean;
  readonly chart: boolean;
}

export interface Workbook {
  readonly sheets: readonly Sheet[];
}

export const MAX_SHEET_COLUMNS = 500;

export function cellPosition(ref: string): { row: number; column: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
  if (!m) return null;
  let column = 0;
  for (const letter of (m[1] as string).toUpperCase())
    column = column * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(m[2]) - 1, column: column - 1 };
}

export function columnName(column: number): string {
  let name = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}
