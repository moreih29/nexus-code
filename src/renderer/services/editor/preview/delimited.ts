export interface DelimitedTable {
  readonly rows: readonly (readonly string[])[];
  readonly columns: number;
}

export function delimiterFor(filePath: string): "," | "\t" {
  return /\.(tsv|tab)$/i.test(filePath) ? "\t" : ",";
}

export function parseDelimited(text: string, delimiter: string): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
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

export function displayWidth(text: string): number {
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
