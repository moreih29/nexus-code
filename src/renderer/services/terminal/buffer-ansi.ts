/**
 * A terminal's lines with their colors and styles, as SGR escapes and no
 * other escapes, for another device to draw them as this window does
 * (terminal.read and terminal.watch with `ansi`), and where its cursor is
 * in them. Each line starts from the default style and ends back at it, so
 * any line can start a text.
 */

import type { TerminalCaret } from "../../../../packages/remote-protocol/src";

/** A cell of xterm's buffer, as much as the escapes need. */
export interface CellLike {
  getWidth(): number;
  getChars(): string;
  isFgDefault(): boolean;
  isFgPalette(): boolean;
  isFgRGB(): boolean;
  getFgColor(): number;
  isBgDefault(): boolean;
  isBgPalette(): boolean;
  isBgRGB(): boolean;
  getBgColor(): number;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
}

/** A row of xterm's buffer; one without its cells reads as plain text. */
export interface AnsiLineLike {
  readonly isWrapped: boolean;
  readonly length?: number;
  translateToString(trimRight?: boolean): string;
  getCell?(x: number, cell?: CellLike): CellLike | undefined;
}

export interface AnsiBufferLike {
  readonly length?: number;
  getLine?(y: number): AnsiLineLike | undefined;
  /** A cell to read the others into, so a line reads without making one per cell. */
  getNullCell?(): CellLike;
}

const ESC = "\x1b[";

function colorParams(
  palette: boolean,
  rgb: boolean,
  color: number,
  base: number,
  bright: number,
  extended: number,
): string[] {
  if (palette) {
    if (color < 8) return [String(base + color)];
    if (color < 16) return [String(bright + color - 8)];
    return [String(extended), "5", String(color)];
  }
  if (rgb) {
    return [
      String(extended),
      "2",
      String((color >> 16) & 0xff),
      String((color >> 8) & 0xff),
      String(color & 0xff),
    ];
  }
  return [];
}

/** The SGR parameters of a cell's style ("1;31"); "" for the default. */
export function sgrOf(cell: CellLike): string {
  const params: string[] = [];
  if (cell.isBold()) params.push("1");
  if (cell.isDim()) params.push("2");
  if (cell.isItalic()) params.push("3");
  if (cell.isUnderline()) params.push("4");
  if (cell.isBlink()) params.push("5");
  if (cell.isInverse()) params.push("7");
  if (cell.isInvisible()) params.push("8");
  if (cell.isStrikethrough()) params.push("9");
  if (cell.isOverline()) params.push("53");
  params.push(...colorParams(cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor(), 30, 90, 38));
  params.push(...colorParams(cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor(), 40, 100, 48));
  return params.join(";");
}

/** A cell that shows nothing: a blank of the default background, unstyled where it would show. */
function blank(cell: CellLike): boolean {
  const chars = cell.getChars();
  return (
    (chars === "" || chars === " ") &&
    cell.isBgDefault() &&
    !cell.isInverse() &&
    !cell.isUnderline() &&
    !cell.isStrikethrough() &&
    !cell.isOverline()
  );
}

/** One row of the buffer with its escapes; its blank end left out when `trim`. */
function rowAnsi(line: AnsiLineLike, cell: CellLike | undefined, trim: boolean): string {
  const at = line.getCell?.bind(line);
  if (!at || line.length === undefined) return line.translateToString(trim);
  let end = line.length;
  if (trim) {
    while (end > 0) {
      const c = at(end - 1, cell);
      if (c && !blank(c)) break;
      end--;
    }
  }
  let out = "";
  let style = "";
  for (let x = 0; x < end; x++) {
    const c = at(x, cell);
    // The second half of a wide character, which the first one draws.
    if (!c || c.getWidth() === 0) continue;
    const sgr = sgrOf(c);
    if (sgr !== style) {
      out += sgr ? `${ESC}0;${sgr}m` : `${ESC}0m`;
      style = sgr;
    }
    out += c.getChars() || " ";
  }
  if (style) out += `${ESC}0m`;
  return out;
}

/** Where the cursor is: its row in the buffer (scrollback included) and its cell in that row. */
export interface CursorAt {
  row: number;
  cell: number;
}

/** A terminal's text with its escapes, and its cursor in it (TerminalCaretSchema). */
export interface AnsiScreen {
  text: string;
  caret?: TerminalCaret;
}

interface Row {
  /** Its first and last rows in the buffer: more than one where the terminal wrapped it. */
  start: number;
  end: number;
  text: string;
}

/** The buffer's lines, a line the terminal wrapped joined back up. */
function rowsOf(buffer: AnsiBufferLike): Row[] {
  const length = buffer.length ?? 0;
  const rows: Row[] = [];
  for (let y = 0; y < length; y++) {
    const line = buffer.getLine?.(y);
    if (!line) continue;
    const text = line.translateToString(true);
    const last = rows[rows.length - 1];
    if (line.isWrapped && last) {
      last.end = y;
      last.text += text;
    } else {
      rows.push({ start: y, end: y, text });
    }
  }
  return rows;
}

/**
 * The characters (code points) of `row` before the cursor's cell, as
 * rowAnsi gives them, a blank cell past the end counting one; undefined
 * for a row without its cells.
 */
function caretColumn(
  buffer: AnsiBufferLike,
  row: Row,
  cursor: CursorAt,
  cell: CellLike | undefined,
): number | undefined {
  let column = 0;
  for (let y = row.start; y <= cursor.row; y++) {
    const line = buffer.getLine?.(y);
    const at = line?.getCell?.bind(line);
    if (!line || !at || line.length === undefined) return undefined;
    const end = y === cursor.row ? cursor.cell : line.length;
    for (let x = 0; x < end; x++) {
      const c = at(x, cell);
      if (c?.getWidth() === 0) continue;
      column += c ? Array.from(c.getChars() || " ").length : 1;
    }
  }
  return column;
}

/**
 * The last `lines` lines it shows, scrollback included, as bufferText
 * tells them (a wrapped line whole, the blank ones at the end left out),
 * with their colors and styles; and, given the cursor, where it is in
 * them, as long as it is not above them.
 */
export function bufferScreen(
  buffer: AnsiBufferLike,
  lines: number,
  cursor?: CursorAt | null,
): AnsiScreen {
  const rows = rowsOf(buffer);
  let last = rows.length;
  while (last > 0 && rows[last - 1]?.text.trim() === "") last--;
  const first = Math.max(0, last - lines);
  const cell = buffer.getNullCell?.();
  const text = rows
    .slice(first, last)
    .map(({ start, end }) => {
      let out = "";
      for (let y = start; y <= end; y++) {
        const line = buffer.getLine?.(y);
        if (line) out += rowAnsi(line, cell, y === end);
      }
      return out;
    })
    .join("\n");
  if (!cursor) return { text };
  const at = rows.findIndex((row) => row.start <= cursor.row && cursor.row <= row.end);
  const row = rows[at];
  if (!row || at < first) return { text };
  const column = caretColumn(buffer, row, cursor, cell);
  return column === undefined ? { text } : { text, caret: { line: at - first, column } };
}

/** bufferScreen's text, without the cursor. */
export function bufferAnsi(buffer: AnsiBufferLike, lines: number): string {
  return bufferScreen(buffer, lines).text;
}
