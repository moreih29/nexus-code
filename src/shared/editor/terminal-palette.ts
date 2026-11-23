import type { ITheme } from "@xterm/xterm";
import { formatHex, parse } from "culori";
import { THEME_SOURCES, THEMES, type ThemeId } from "../design-tokens";
import type { SemanticTokenSet } from "../design-tokens/semantic";

function toHex(value: string): string {
  const parsed = parse(value);
  if (!parsed) return value;
  return formatHex(parsed) ?? value;
}

function buildTerminalPalette(tokens: SemanticTokenSet, selBg: string): ITheme {
  return {
    background: "#00000000",
    foreground: toHex(tokens["terminal.fg"]),
    cursor: toHex(tokens["terminal.cursor.color"]),
    cursorAccent: toHex(tokens["terminal.cursor.accent"]),
    selectionBackground: selBg,
    black: toHex(tokens["terminal.ansi.black"]),
    red: toHex(tokens["terminal.ansi.red"]),
    green: toHex(tokens["terminal.ansi.green"]),
    yellow: toHex(tokens["terminal.ansi.yellow"]),
    blue: toHex(tokens["terminal.ansi.blue"]),
    magenta: toHex(tokens["terminal.ansi.magenta"]),
    cyan: toHex(tokens["terminal.ansi.cyan"]),
    white: toHex(tokens["terminal.ansi.white"]),
    brightBlack: toHex(tokens["terminal.ansi.brightBlack"]),
    brightRed: toHex(tokens["terminal.ansi.brightRed"]),
    brightGreen: toHex(tokens["terminal.ansi.brightGreen"]),
    brightYellow: toHex(tokens["terminal.ansi.brightYellow"]),
    brightBlue: toHex(tokens["terminal.ansi.brightBlue"]),
    brightMagenta: toHex(tokens["terminal.ansi.brightMagenta"]),
    brightCyan: toHex(tokens["terminal.ansi.brightCyan"]),
    brightWhite: toHex(tokens["terminal.ansi.brightWhite"]),
  };
}

export const TERMINAL_PALETTES: Record<ThemeId, ITheme> = Object.fromEntries(
  THEME_SOURCES.map((source) => [
    source.id,
    buildTerminalPalette(THEMES[source.id], source.selectionSolid),
  ]),
) as Record<ThemeId, ITheme>;
