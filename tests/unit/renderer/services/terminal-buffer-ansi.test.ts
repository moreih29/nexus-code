/** bufferAnsi: a terminal's lines with their colors and styles, for another device. */
import { expect, test } from "bun:test";
import {
  type AnsiLineLike,
  bufferAnsi,
  type CellLike,
  sgrOf,
} from "../../../../src/renderer/services/terminal/buffer-ansi";

interface Style {
  bold?: boolean;
  inverse?: boolean;
  fg?: { palette: number } | { rgb: number };
  bg?: { palette: number } | { rgb: number };
}

function cell(chars: string, style: Style = {}, width = 1): CellLike {
  const n = (on?: boolean) => (on ? 1 : 0);
  return {
    getWidth: () => width,
    getChars: () => chars,
    isFgDefault: () => !style.fg,
    isFgPalette: () => !!style.fg && "palette" in style.fg,
    isFgRGB: () => !!style.fg && "rgb" in style.fg,
    getFgColor: () => (style.fg ? ("palette" in style.fg ? style.fg.palette : style.fg.rgb) : 0),
    isBgDefault: () => !style.bg,
    isBgPalette: () => !!style.bg && "palette" in style.bg,
    isBgRGB: () => !!style.bg && "rgb" in style.bg,
    getBgColor: () => (style.bg ? ("palette" in style.bg ? style.bg.palette : style.bg.rgb) : 0),
    isBold: () => n(style.bold),
    isDim: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => n(style.inverse),
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
  };
}

const text = (s: string, style?: Style) => [...s].map((c) => cell(c, style));

function row(cells: CellLike[], width = 10, wrapped = false): AnsiLineLike {
  const all = [...cells, ...Array.from({ length: width - cells.length }, () => cell(""))];
  return {
    isWrapped: wrapped,
    length: width,
    translateToString: (trim) => {
      const s = all.map((c) => c.getChars() || (c.getWidth() === 0 ? "" : " ")).join("");
      return trim ? s.trimEnd() : s;
    },
    getCell: (x) => all[x],
  };
}

const buffer = (rows: AnsiLineLike[]) => ({ length: rows.length, getLine: (y: number) => rows[y] });

test("a style's SGR parameters: the basic, bright, 256 and true colors", () => {
  expect(sgrOf(cell("a"))).toBe("");
  expect(sgrOf(cell("a", { bold: true, fg: { palette: 1 } }))).toBe("1;31");
  expect(sgrOf(cell("a", { fg: { palette: 9 }, bg: { palette: 4 } }))).toBe("91;44");
  expect(sgrOf(cell("a", { fg: { palette: 208 }, bg: { palette: 12 } }))).toBe("38;5;208;104");
  expect(sgrOf(cell("a", { fg: { rgb: 0x112233 }, bg: { rgb: 0xff0080 } }))).toBe(
    "38;2;17;34;51;48;2;255;0;128",
  );
});

test("each line starts and ends at the default style, its blank end left out", () => {
  const out = bufferAnsi(
    buffer([
      row([...text("ok", { fg: { palette: 2 } }), ...text(" done")]),
      row(text("plain")),
      row([]),
    ]),
    10,
  );
  expect(out).toBe("\x1b[0;32mok\x1b[0m done\nplain");
});

test("a colored blank at the end shows; a wide character once", () => {
  const out = bufferAnsi(
    buffer([row([cell("한", {}, 2), cell("", {}, 0), ...text("  ", { bg: { palette: 4 } })])]),
    10,
  );
  expect(out).toBe("한\x1b[0;44m  \x1b[0m");
});

test("a wrapped line whole, and only the last lines asked for", () => {
  const rows = [
    row(text("first")),
    row(text("0123456789", { inverse: true })),
    row(text("ab", { inverse: true }), 10, true),
  ];
  expect(bufferAnsi(buffer(rows), 1)).toBe("\x1b[0;7m0123456789\x1b[0m\x1b[0;7mab\x1b[0m");
});

test("rows without their cells read as plain text", () => {
  const plain = { isWrapped: false, translateToString: () => "no cells" };
  expect(bufferAnsi(buffer([plain as AnsiLineLike]), 5)).toBe("no cells");
});
