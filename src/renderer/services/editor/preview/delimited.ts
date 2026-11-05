/**
 * Comma- and tab-separated values, for the table preview of .csv and .tsv
 * files: rows of fields as RFC 4180 reads them, quotes and all.
 */

export interface DelimitedTable {
  /** Every row, the header first; rows may differ in length. */
  readonly rows: readonly (readonly string[])[];
  /** The widest row's number of fields. */
  readonly columns: number;
}

/** The delimiter of a file by its extension: tab for .tsv and .tab, comma otherwise. */
export function delimiterFor(filePath: string): "," | "\t" {
  return /\.(tsv|tab)$/i.test(filePath) ? "\t" : ",";
}

/**
 * Reads `text` as delimited values. A field in double quotes may hold the
 * delimiter, line breaks, and "" for a quote. A line break ends a row:
 * \n, \r\n or \r. The last line's break is not a row of its own, and a
 * byte order mark is dropped.
 */
export function parseDelimited(text: string, delimiter: string): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  /** Whether the row being read has anything yet, an empty quoted field included. */
  let started = false;
  let columns = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    rows.push(row);
    columns = Math.max(columns, row.length);
    row = [];
    started = false;
  };
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c !== "\n" && c !== "\r") started = true;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i += 1;
    } else field += c;
    i += 1;
  }
  if (started || quoted) endRow();
  return { rows, columns };
}

/**
 * How wide each column shows, in characters: its widest field among the
 * first `sample` rows, the header included, within `min` and `max`. Widths
 * stay as the table scrolls, rather than following the rows in view.
 */
export function columnWidths(
  table: DelimitedTable,
  { sample = 1000, min = 4, max = 40 }: { sample?: number; min?: number; max?: number } = {},
): number[] {
  const widths = new Array<number>(table.columns).fill(min);
  for (const row of table.rows.slice(0, sample)) {
    row.forEach((field, column) => {
      const width = Math.min(max, displayWidth(field));
      if (width > (widths[column] ?? 0)) widths[column] = width;
    });
  }
  return widths;
}

/** Columns a field takes in one line: wide (CJK, Hangul) characters take two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60)
        ? 2
        : 1;
    if (width > 200) break;
  }
  return width;
}
