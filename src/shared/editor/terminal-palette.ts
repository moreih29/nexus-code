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
// Design source: src/shared/design-tokens/themes/*.ts → terminal.* keys.
// design.md §9 Region Semantics: terminal region vocabulary.

import { formatHex, formatHex8, parse } from "culori";
import type { ITheme } from "@xterm/xterm";
import { THEMES } from "../design-tokens/themes";
import type { ThemeId } from "../design-tokens/themes";
import type { SemanticTokenSet } from "../design-tokens/semantic";

// ---------------------------------------------------------------------------
// toHex — convert any CSS color string culori can parse to #rrggbb.
// rgba() alpha is intentionally discarded: xterm renders its own selection
// overlay on top of the background; passing a semi-transparent rgba would
// produce incorrect results. For selectionBackground we use a dedicated
// solid approximation baked into each theme's palette below.
// Returns the original string if culori cannot parse it (should not happen
// for values in themes/*.ts, but avoids silent breakage).
// ---------------------------------------------------------------------------

function toHex(value: string): string {
  const parsed = parse(value);
  if (!parsed) return value;
  return formatHex(parsed) ?? value;
}

// ---------------------------------------------------------------------------
// toHexAlpha — like toHex but preserves an explicit alpha as #rrggbbaa.
// Used only for `background` so the terminal surface is translucent and the
// macOS window vibrancy shows through (requires allowTransparency on the
// Terminal instance). All other palette keys stay opaque via toHex.
// ---------------------------------------------------------------------------

function toHexAlpha(value: string, alpha: number): string {
  const parsed = parse(value);
  if (!parsed) return value;
  return formatHex8({ ...parsed, alpha }) ?? value;
}

// ---------------------------------------------------------------------------
// buildTerminalPalette — derive xterm ITheme from a SemanticTokenSet.
//
// selectionBackground: ANSI selection in xterm must be a solid hex color.
// The semantic token is rgba — we pre-bake a solid approximation per theme:
//   warm-dark / warm-light terminal: rgba(255,255,255,0.10) on #1a1917 → #2e2d2b
//   cool-dark terminal: rgba(200,210,255,0.12) on oklch(0.18,0.008,245)≈#191b1f → #2c2e36
// ---------------------------------------------------------------------------

function buildTerminalPalette(tokens: SemanticTokenSet, selBg: string): ITheme {
  return {
    background: toHexAlpha(tokens["terminal.bg"], 0), // fully transparent — terminal shows the island surface
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
// TERMINAL_PALETTES — pre-built ITheme per ThemeId.
//
// selectionBackground solid approximations (rgba blended onto terminal.bg):
//   warm-dark:  rgba(255,255,255,0.10) on #1a1917 → approx #2e2d2b
//   cool-dark:  rgba(200,210,255,0.12) on #191b1f → approx #2e303a
//   warm-light: rgba(255,255,255,0.12) on #1a1917 → approx #2f2e2c
//               (terminal.bg is also #1a1917 in warm-light — inverted zone)
// ---------------------------------------------------------------------------

export const TERMINAL_PALETTES: Record<ThemeId, ITheme> = {
  "warm-dark": buildTerminalPalette(THEMES["warm-dark"], "#2e2d2b"),
  "cool-dark": buildTerminalPalette(THEMES["cool-dark"], "#2e303a"),
  "warm-light": buildTerminalPalette(THEMES["warm-light"], "#2f2e2c"),
};
