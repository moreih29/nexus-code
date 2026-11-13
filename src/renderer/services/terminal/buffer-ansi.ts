/**
 * A terminal's lines with their colors and styles, as SGR escapes and no
 * other escapes, for another device to draw them as this window does
 * (terminal.read and terminal.watch with `ansi`). Each line starts from
 * the default style and ends back at it, so any line can start a text.
 */

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

/**
 * The last `lines` lines it shows, scrollback included, as bufferText
 * tells them (a wrapped line whole, the blank ones at the end left out),
 * with their colors and styles.
 */
export function bufferAnsi(buffer: AnsiBufferLike, lines: number): string {
  const length = buffer.length ?? 0;
  const rows: { start: number; end: number; text: string }[] = [];
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
  while (rows.length > 0 && rows[rows.length - 1]?.text.trim() === "") rows.pop();
  const cell = buffer.getNullCell?.();
  return rows
    .slice(-lines)
    .map(({ start, end }) => {
      let out = "";
      for (let y = start; y <= end; y++) {
        const line = buffer.getLine?.(y);
        if (line) out += rowAnsi(line, cell, y === end);
      }
      return out;
    })
    .join("\n");
}
