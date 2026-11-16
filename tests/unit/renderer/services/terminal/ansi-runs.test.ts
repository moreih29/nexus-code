/**
 * Another computer's terminal text read into styled runs, as the phone reads it.
 */
import { describe, expect, test } from "bun:test";
import {
  paletteColor,
  parseAnsi,
  sixteenOf,
  stripAnsi,
} from "../../../../../src/renderer/services/terminal/ansi-runs";

const ESC = "\x1b";

describe("parseAnsi", () => {
  test("plain text is one plain run", () => {
    expect(parseAnsi("hello\nworld")).toEqual([{ text: "hello\nworld", style: {} }]);
  });

  test("reads colors, emphasis and resets", () => {
    const runs = parseAnsi(`${ESC}[1;31merror${ESC}[0m: ${ESC}[92mok${ESC}[39m done`);
    expect(runs.map((r) => r.text)).toEqual(["error", ": ", "ok", " done"]);
    expect(runs[0]?.style).toEqual({ bold: true, fg: 1 });
    expect(runs[1]?.style).toEqual({});
    expect(runs[2]?.style).toEqual({ fg: 10 });
    expect(runs[3]?.style).toEqual({ fg: undefined });
  });

  test("hides and shows again (8, 28)", () => {
    const runs = parseAnsi(`a${ESC}[8mb${ESC}[28mc`);
    expect(runs.map((r) => [r.text, r.style.hidden])).toEqual([
      ["a", undefined],
      ["b", true],
      ["c", false],
    ]);
  });

  test("reads 256 colors and true color, in both forms", () => {
    expect(parseAnsi(`${ESC}[38;5;208mx`)[0]?.style.fg).toBe(208);
    expect(parseAnsi(`${ESC}[48;2;255;0;16mx`)[0]?.style.bg).toBe("#ff0010");
    expect(parseAnsi(`${ESC}[38:2::1:2:3mx`)[0]?.style.fg).toBe("#010203");
    expect(parseAnsi(`${ESC}[38;5;208;1mx`)[0]?.style).toEqual({ fg: 208, bold: true });
  });

  test("drops other escapes: cursor moves, titles, charsets", () => {
    const text = `${ESC}]0;title${ESC}\\${ESC}[2K${ESC}[?25la${ESC}(Bb${ESC}=c`;
    expect(parseAnsi(text)).toEqual([{ text: "abc", style: {} }]);
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });
});

describe("paletteColor", () => {
  const sixteen = Array.from({ length: 16 }, (_, i) => `#${String(i).padStart(6, "0")}`);
  test("takes the theme's first 16, then the cube and the grays", () => {
    expect(paletteColor(3, sixteen)).toBe("#000003");
    expect(paletteColor(16, sixteen)).toBe("#000000");
    expect(paletteColor(196, sixteen)).toBe("#ff0000");
    expect(paletteColor(232, sixteen)).toBe("#080808");
    expect(paletteColor(255, sixteen)).toBe("#eeeeee");
  });
});

describe("sixteenOf", () => {
  test("puts xterm's named colors in SGR's order", () => {
    const sixteen = sixteenOf({ black: "#000000", red: "#ff0000", brightWhite: "#fefefe" });
    expect(sixteen).toHaveLength(16);
    expect(sixteen[0]).toBe("#000000");
    expect(sixteen[1]).toBe("#ff0000");
    expect(sixteen[15]).toBe("#fefefe");
  });
});
