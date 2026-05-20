// terminal-palette.ts — xterm ITheme palette per ThemeId.
//
// Converts semantic token OKLCH/hex color values to #rrggbb hex strings
// required by xterm's ITheme API. xterm 6.x rejects rgba()/oklch() in
// theme options and falls back to defaults.
//
// Palette coverage:
//   background, foreground, cursor, cursorAccent, selectionBackground
//   + ANSI 16 colors (black…white, brightBlack…brightWhite)
//
// Consumed by: src/renderer/services/terminal/controller.ts
//
// Design source: src/shared/design-tokens/theme-sources.ts (each ThemeSource
// supplies a `selectionSolid` hex; the rest is derived from semantic tokens).

import { formatHex, parse } from "culori";
import type { ITheme } from "@xterm/xterm";
import { THEMES, THEME_SOURCES, type ThemeId } from "../design-tokens";
import type { SemanticTokenSet } from "../design-tokens/semantic";

// ---------------------------------------------------------------------------
// toHex — convert any CSS color string culori can parse to #rrggbb.
// rgba() alpha is intentionally discarded: xterm renders its own selection
// overlay on top of the background; passing a semi-transparent rgba would
// produce incorrect results.
// Returns the original string if culori cannot parse it (should not happen
// for values in themes/*.ts, but avoids silent breakage).
// ---------------------------------------------------------------------------

function toHex(value: string): string {
  const parsed = parse(value);
  if (!parsed) return value;
  return formatHex(parsed) ?? value;
}

// ---------------------------------------------------------------------------
// buildTerminalPalette — derive xterm ITheme from a SemanticTokenSet.
//
// selectionBackground: ANSI selection in xterm must be a solid hex color.
// Each ThemeSource pre-bakes one in `selectionSolid`; we pass that through.
// ---------------------------------------------------------------------------

function buildTerminalPalette(tokens: SemanticTokenSet, selBg: string): ITheme {
  return {
    background: "#00000000", // fully transparent — terminal shows the island surface
    foreground: toHex(tokens["terminal.fg"]),
    cursor: toHex(tokens["terminal.cursor.color"]),
    cursorAccent: toHex(tokens["terminal.cursor.accent"]),
    selectionBackground: selBg,
    // ANSI 16 colors
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

// ---------------------------------------------------------------------------
// TERMINAL_PALETTES — pre-built ITheme per ThemeId. Iterates THEME_SOURCES
// so a new theme is auto-included when it ships in theme-sources.ts.
// ---------------------------------------------------------------------------

export const TERMINAL_PALETTES: Record<ThemeId, ITheme> = Object.fromEntries(
  THEME_SOURCES.map((source) => [
    source.id,
    buildTerminalPalette(THEMES[source.id], source.selectionSolid),
  ]),
) as Record<ThemeId, ITheme>;
