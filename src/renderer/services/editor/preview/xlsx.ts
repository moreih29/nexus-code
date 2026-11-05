/**
 * Reading Excel workbooks (.xlsx, .xlsm) for the spreadsheet preview: each
 * visible sheet's cells as the spreadsheet application last showed them.
 * Loaded with the first spreadsheet opened, not with the app.
 *
 * A formula's value is the one the application computed and saved with the
 * file; nothing is computed here. Numbers and dates are written out in the
 * cell's number format. Macros, charts and pictures are not read.
 */

import { type Unzipped, unzipSync } from "fflate";
import { format, getFormatFromId, isDateFormat } from "numfmt";
import { displayWidth } from "./delimited";
import {
  cellPosition,
  MAX_SHEET_COLUMNS,
  type Sheet,
  type SheetCell,
  type Workbook,
} from "./spreadsheet";
import { scanXml } from "./xml";

/** The largest part of the file read, uncompressed; a larger one is refused. */
const MAX_PART_BYTES = 256 * 1024 * 1024;

export class SpreadsheetError extends Error {
  override name = "SpreadsheetError";
}

/**
 * Reads a workbook from the bytes of its file. Throws SpreadsheetError for
 * one it cannot read: not a zip, or with no workbook in it.
 */
export function readWorkbook(bytes: Uint8Array): Workbook {
  let files: Unzipped;
  try {
    files = unzipSync(bytes, {
      filter: (f) => /\.(xml|rels)$/i.test(f.name) && f.originalSize <= MAX_PART_BYTES,
    });
  } catch {
    throw new SpreadsheetError("not a zip archive");
  }
  const decoder = new TextDecoder();
  const part = (path: string): string | null => {
    const data = files[path];
    return data ? decoder.decode(data) : null;
  };

  const root = relationships(part("_rels/.rels"), "");
  const workbookPath =
    [...root.values()].find((r) => r.type.endsWith("/officeDocument"))?.target ?? "xl/workbook.xml";
  const workbookXml = part(workbookPath);
  if (workbookXml === null) throw new SpreadsheetError("no workbook");
  const rels = relationships(part(relsPathOf(workbookPath)), workbookPath);
  const relOfType = (type: string) =>
    [...rels.values()].find((r) => r.type.endsWith(`/${type}`))?.target;

  const sharedStringsPath = relOfType("sharedStrings");
  const strings = sharedStrings(sharedStringsPath ? part(sharedStringsPath) : null);
  const stylesPath = relOfType("styles");
  const formats = cellFormats(stylesPath ? part(stylesPath) : null);
  const book = workbookSheets(workbookXml);

  const sheets: Sheet[] = [];
  for (const entry of book.sheets) {
    if (entry.hidden) continue;
    const rel = rels.get(entry.relId);
    const xml = rel ? part(rel.target) : null;
    if (rel?.type.endsWith("/chartsheet")) {
      sheets.push({ ...EMPTY_SHEET, name: entry.name, chart: true });
    } else if (xml === null) {
      sheets.push({ ...EMPTY_SHEET, name: entry.name });
    } else {
      sheets.push(readSheet(entry.name, xml, { strings, formats, date1904: book.date1904 }));
    }
  }
  return { sheets };
}

const EMPTY_SHEET: Omit<Sheet, "name"> = {
  rows: [],
  columns: 0,
  widths: [],
  clipped: false,
  chart: false,
};

interface Relationship {
  readonly type: string;
  /** The part it points to, as a path in the archive. */
  readonly target: string;
}

/** A .rels part's relationships by id, their targets resolved against `source`. */
function relationships(xml: string | null, source: string): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  if (xml === null) return rels;
  scanXml(xml, {
    start(name, attrs) {
      if (name !== "Relationship" || attrs.TargetMode === "External") return;
      const { Id, Type, Target } = attrs;
      if (Id && Type && Target) rels.set(Id, { type: Type, target: resolvePart(source, Target) });
    },
  });
  return rels;
}

/** Where the relationships of the part at `path` are kept. */
function relsPathOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return `${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`;
}

/** `target` as a path in the archive, read from the part at `source`. */
export function resolvePart(source: string, target: string): string {
  const base = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") base.pop();
    else if (segment !== "." && segment !== "") base.push(segment);
  }
  return base.join("/");
}

interface WorkbookSheet {
  readonly name: string;
  readonly relId: string;
  readonly hidden: boolean;
}

function workbookSheets(xml: string): { sheets: WorkbookSheet[]; date1904: boolean } {
  const sheets: WorkbookSheet[] = [];
  let date1904 = false;
  scanXml(xml, {
    start(name, attrs) {
      if (name === "workbookPr") date1904 = isTrue(attrs.date1904);
      if (name !== "sheet") return;
      const relId = Object.entries(attrs).find(([key]) => key.endsWith(":id"))?.[1] ?? "";
      sheets.push({
        name: attrs.name ?? "",
        relId,
        hidden: attrs.state === "hidden" || attrs.state === "veryHidden",
      });
    },
  });
  return { sheets, date1904 };
}

function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** The shared strings, in order, with the text of each one's runs joined. */
function sharedStrings(xml: string | null): string[] {
  const strings: string[] = [];
  if (xml === null) return strings;
  let current: string[] | null = null;
  let inText = false;
  /** Inside a phonetic reading, whose text is not the cell's. */
  let phonetic = 0;
  scanXml(xml, {
    start(name, _attrs, empty) {
      if (name === "si") current = [];
      else if (name === "rPh" && !empty) phonetic++;
      else if (name === "t" && !empty) inText = true;
    },
    end(name) {
      if (name === "si" && current) {
        strings.push(unescapeXstring(current.join("")));
        current = null;
      } else if (name === "rPh") phonetic = Math.max(0, phonetic - 1);
      else if (name === "t") inText = false;
    },
    text(text) {
      if (inText && phonetic === 0) current?.push(text);
    },
  });
  return strings;
}

/** Excel writes characters XML cannot hold as _xHHHH_. */
function unescapeXstring(text: string): string {
  if (!text.includes("_x")) return text;
  return text.replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** Each cell style's number format, by style index. */
function cellFormats(xml: string | null): string[] {
  const formats: string[] = [];
  if (xml === null) return formats;
  const custom = new Map<number, string>();
  let inCellXfs = false;
  scanXml(xml, {
    start(name, attrs, empty) {
      if (name === "numFmt" && attrs.numFmtId !== undefined) {
        custom.set(Number(attrs.numFmtId), attrs.formatCode ?? "General");
      } else if (name === "cellXfs" && !empty) inCellXfs = true;
      else if (name === "xf" && inCellXfs) {
        const id = Number(attrs.numFmtId ?? 0);
        formats.push(custom.get(id) ?? getFormatFromId(id) ?? "General");
      }
    },
    end(name) {
      if (name === "cellXfs") inCellXfs = false;
    },
  });
  return formats;
}

interface SheetContext {
  readonly strings: readonly string[];
  readonly formats: readonly string[];
  readonly date1904: boolean;
}

function readSheet(name: string, xml: string, context: SheetContext): Sheet {
  const rows: (SheetCell | undefined)[][] = [];
  const fileWidths: (number | undefined)[] = [];
  let columns = 0;
  let clipped = false;

  let row = -1;
  let column = -1;
  let cell: { type: string; style: number } | null = null;
  /** Which of the cell's elements text is being read for. */
  let reading: "v" | "t" | null = null;
  let value: string[] = [];
  let inline = false;

  scanXml(xml, {
    start(tag, attrs, empty) {
      switch (tag) {
        case "col": {
          const width = Number(attrs.width);
          const min = Number(attrs.min);
          const max = Math.min(Number(attrs.max), MAX_SHEET_COLUMNS);
          if (Number.isFinite(width) && min >= 1) {
            for (let c = min; c <= max; c++) fileWidths[c - 1] = width;
          }
          break;
        }
        case "row":
          row = attrs.r ? Number(attrs.r) - 1 : row + 1;
          column = -1;
          break;
        case "c": {
          const at = attrs.r ? cellPosition(attrs.r) : null;
          if (at) row = at.row;
          column = at ? at.column : column + 1;
          cell = { type: attrs.t ?? "n", style: Number(attrs.s ?? 0) };
          value = [];
          inline = false;
          if (empty) cell = null;
          break;
        }
        case "v":
          if (cell && !empty) reading = "v";
          break;
        case "is":
          inline = true;
          break;
        case "t":
          if (cell && inline && !empty) reading = "t";
          break;
      }
    },
    end(tag) {
      if (tag === "v" || tag === "t") reading = null;
      if (tag !== "c" || !cell) return;
      const text = cellText(cell.type, cell.style, value.join(""), context);
      cell = null;
      if (text === null || row < 0 || column < 0) return;
      if (column >= MAX_SHEET_COLUMNS) {
        clipped = true;
        return;
      }
      rows[row] ??= [];
      (rows[row] as (SheetCell | undefined)[])[column] = text;
      columns = Math.max(columns, column + 1);
    },
    text(text) {
      if (reading) value.push(text);
    },
  });

  return {
    name,
    rows,
    columns,
    widths: columnWidths(rows, columns, fileWidths),
    clipped,
    chart: false,
  };
}

function cellText(
  type: string,
  style: number,
  raw: string,
  { strings, formats, date1904 }: SheetContext,
): SheetCell | null {
  switch (type) {
    case "s": {
      const text = strings[Number(raw)];
      return text ? { text, numeric: false } : null;
    }
    case "str":
    case "inlineStr":
    case "d":
      return raw === "" ? null : { text: unescapeXstring(raw), numeric: false };
    case "b":
      return raw === "" ? null : { text: raw === "1" ? "TRUE" : "FALSE", numeric: false };
    case "e":
      return raw === "" ? null : { text: raw, numeric: false };
    default: {
      if (raw === "") return null;
      const number = Number(raw);
      if (!Number.isFinite(number)) return { text: raw, numeric: false };
      return { text: formatNumber(number, formats[style] ?? "General", date1904), numeric: true };
    }
  }
}

/** Days from 1900-01-00 to 1904-01-01, for a workbook that counts dates from 1904. */
const DATE_1904_OFFSET = 1462;

function formatNumber(number: number, pattern: string, date1904: boolean): string {
  try {
    const value = date1904 && isDateFormat(pattern) ? number + DATE_1904_OFFSET : number;
    return format(pattern, value);
  } catch {
    return format("General", number);
  }
}

/** About how many rows a column's text width is taken from. */
const WIDTH_SAMPLE_ROWS = 2000;

/**
 * Each column's width: the file's, else its widest text within bounds,
 * among rows taken evenly through the sheet (all of a small one), so a
 * column whose values grow down the sheet is not sized by its first ones.
 */
function columnWidths(
  rows: readonly (readonly (SheetCell | undefined)[] | undefined)[],
  columns: number,
  fileWidths: readonly (number | undefined)[],
): number[] {
  const widths = new Array<number>(columns).fill(4);
  const stride = Math.max(1, Math.floor(rows.length / WIDTH_SAMPLE_ROWS));
  for (let index = 0; index < rows.length; index++) {
    if (index % stride !== 0 && index !== rows.length - 1) continue;
    rows[index]?.forEach((cell, column) => {
      if (cell) {
        widths[column] = Math.max(widths[column] ?? 0, Math.min(40, displayWidth(cell.text)));
      }
    });
  }
  return widths.map((width, column) => {
    const own = fileWidths[column];
    return own === undefined ? width : Math.min(80, Math.max(2, Math.round(own)));
  });
}
