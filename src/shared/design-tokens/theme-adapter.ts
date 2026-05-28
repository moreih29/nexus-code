// theme-adapter.ts — derive SemanticTokenSet + EditorPalette from a ThemeSource.
//
// The adapter is the bridge between minimal authoring data (ThemeSource) and
// the two parallel runtime contracts:
//   - SemanticTokenSet (84 SemanticKey entries — UI chrome + editor + terminal)
//   - EditorPalette    (~40 keys — Monaco chrome + syntax)
//
// Both contracts must be fully satisfied for any theme. The adapter applies
// uniform derivation rules so themes don't have to repeat the same logic.
//
// Derivation strategy summary:
//   - Surface keys     ← source.bg / source.fg (3-tier mapping)
//   - State overlays   ← per-base alpha tiers on white/black overlay
//   - Git lanes        ← OKLCH 8-color rotation (theme-agnostic, perceptually even)
//   - Git status       ← source.success / warning / error / info
//   - Terminal ANSI    ← source.ansi (1:1)
//   - Editor chrome    ← source.* with alpha-tier derivation for Monaco
//   - Syntax 15-role   ← source.syntax (1:1)

import { converter, formatHex8, parse } from "culori";
import type { SemanticTokenSet } from "./semantic";
import type { ThemeSource } from "./theme-sources";

// ---------------------------------------------------------------------------
// pickContrastFg — return a high-contrast foreground (#fff or theme bg) for a
// given background. Used for `state.selected.fg` so primary buttons / slider
// thumbs / checked checkboxes get a readable label against the accent fill.
// Uses WCAG relative luminance with the 0.5 threshold.
// ---------------------------------------------------------------------------

const toRgb = converter("rgb");

function pickContrastFg(bg: string, darkChoice: string): string {
  const parsed = parse(bg);
  if (!parsed) return "#ffffff";
  const rgb = toRgb(parsed);
  if (!rgb) return "#ffffff";
  // WCAG relative luminance (linearized — culori RGB channels are 0..1 sRGB).
  // We use the non-linearized approximation; the 0.5 threshold is robust for
  // typical accent hues at saturated chroma.
  const lum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return lum > 0.55 ? darkChoice : "#ffffff";
}

// ---------------------------------------------------------------------------
// tintedAccent — emit an rgba() that mixes the accent's RGB with the surface
// at the given alpha. Used for "subtle but visible" selected backgrounds
// (sidebar rows, file tree rows) where a flat accent would be too loud but a
// pure surface overlay would vanish on light themes.
// ---------------------------------------------------------------------------

function tintedAccent(accent: string, _surface: string, alpha: number): string {
  const a = parse(accent);
  if (!a) return accent;
  const rgb = toRgb(a);
  if (!rgb) return accent;
  const r = Math.round(rgb.r * 255);
  const g = Math.round(rgb.g * 255);
  const b = Math.round(rgb.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// EditorPalette — Monaco chrome + syntax. Mirrors src/shared/editor/palette.ts.
// Re-declared here (rather than imported) to keep this file the SOLE producer
// of the EditorPalette so the editor module can stay a thin re-exporter.
// ---------------------------------------------------------------------------

export interface EditorPalette {
  // word highlight
  wordHighlightBackground: string;
  wordHighlightStrongBackground: string;
  wordHighlightTextBackground: string;
  // find/match
  findRangeHighlightBackground: string;
  findMatchHighlightBackground: string;
  findMatchBackground: string;
  // peek
  peekViewBorder: string;
  peekViewEditorMatchHighlightBackground: string;
  peekViewResultMatchHighlightBackground: string;
  peekViewResultBackground: string;
  // link
  linkForeground: string;
  linkActiveForeground: string;
  // selection
  selectionBackground: string;
  inactiveSelectionBackground: string;
  selectionHighlightBackground: string;
  // widget surfaces
  hoverWidgetBackground: string;
  hoverWidgetBorder: string;
  editorWidgetBackground: string;
  editorWidgetBorder: string;
  // diagnostic
  errorForeground: string;
  warningForeground: string;
  infoForeground: string;
  hintForeground: string;
  errorBackground: string;
  warningBackground: string;
  infoBackground: string;
  hintBackground: string;
  // editor surface
  editorBackground: string;
  // syntax — 15 roles per design.md §15.1
  syntaxKeyword: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxComment: string;
  syntaxFunction: string;
  syntaxType: string;
  syntaxVariable: string;
  syntaxConstant: string;
  syntaxProperty: string;
  syntaxOperator: string;
  syntaxTag: string;
  syntaxAttribute: string;
  syntaxNamespace: string;
  syntaxRegexp: string;
  syntaxInvalid: string;
}

// ---------------------------------------------------------------------------
// Color utilities — convert any CSS color string to Monaco-compatible hex.
// ---------------------------------------------------------------------------

/** Convert any CSS color to 8-digit hex (#rrggbbaa). Used for Monaco palette. */
function toHex8(value: string, alphaOverride?: number): string {
  const parsed = parse(value);
  if (!parsed) {
    // If parsing fails, return the value unchanged — surfaces silent errors
    // upstream rather than producing a #ff0000 sentinel via Monaco.
    return value;
  }
  if (alphaOverride !== undefined) {
    return formatHex8({ ...parsed, alpha: alphaOverride }) ?? value;
  }
  return formatHex8(parsed) ?? value;
}

/** Mix a foreground color over a solid surface at a given alpha, return #rrggbb. */
function alphaOnSurface(fg: string, surface: string, alpha: number): string {
  const fgP = parse(fg);
  const sP = parse(surface);
  if (!fgP || !sP) return fg;
  // Simple Porter-Duff over compositing in sRGB (Monaco doesn't care about
  // perceptual blend, and the difference vs OKLCH blend is imperceptible at
  // these alphas).
  const fgRgb = {
    r: (fgP as { r?: number }).r ?? 0,
    g: (fgP as { g?: number }).g ?? 0,
    b: (fgP as { b?: number }).b ?? 0,
  };
  const sRgb = {
    r: (sP as { r?: number }).r ?? 0,
    g: (sP as { g?: number }).g ?? 0,
    b: (sP as { b?: number }).b ?? 0,
  };
  const mix = {
    mode: "rgb" as const,
    r: fgRgb.r * alpha + sRgb.r * (1 - alpha),
    g: fgRgb.g * alpha + sRgb.g * (1 - alpha),
    b: fgRgb.b * alpha + sRgb.b * (1 - alpha),
  };
  return formatHex8(mix) ?? fg;
}

// ---------------------------------------------------------------------------
// Per-base overlay tiers — design.md §7 "alpha tier" pattern.
// Dark themes overlay white on the surface; light themes overlay black.
// ---------------------------------------------------------------------------

function overlay(base: "dark" | "light", alpha: number): string {
  const rgb = base === "dark" ? "255, 255, 255" : "0, 0, 0";
  return `rgba(${rgb}, ${alpha})`;
}

/**
 * Apply an alpha multiplier to any CSS color string.
 * Returns an rgba() string parsed from the original color; falls back to
 * the original value if parsing fails.  Used for sidebar.item.focus.border
 * and similar semantic tokens that need a semi-transparent version of an
 * existing surface color without introducing a new primitive.
 */
function withAlpha(color: string, alpha: number): string {
  const parsed = parse(color);
  if (!parsed) return color;
  const rgb = toRgb(parsed);
  if (!rgb) return color;
  const r = Math.round((rgb.r ?? 0) * 255);
  const g = Math.round((rgb.g ?? 0) * 255);
  const b = Math.round((rgb.b ?? 0) * 255);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Git lane palette — 8 perceptually even hues at constant L/C.
// Theme-agnostic so lanes stay visually distinct on every theme; minor
// lightness tweak per base for readability.
// ---------------------------------------------------------------------------

function gitLanes(
  base: "dark" | "light",
): readonly [string, string, string, string, string, string, string, string] {
  // Lightness + chroma calibrated for WCAG ~3:1 minimum vs typical editor bg.
  const L = base === "dark" ? 0.66 : 0.52;
  const C = base === "dark" ? 0.13 : 0.14;
  // Hue rotation — start at 25° (warm red) and spread 8 lanes evenly.
  // This intentionally avoids forming a "rainbow" that matches any theme's
  // own palette too closely — the lanes are a global coordinate system.
  return [
    `oklch(${L} ${C} 25)`,
    `oklch(${L} ${C} 70)`,
    `oklch(${L} ${C} 115)`,
    `oklch(${L} ${C} 160)`,
    `oklch(${L} ${C} 205)`,
    `oklch(${L} ${C} 250)`,
    `oklch(${L} ${C} 295)`,
    `oklch(${L} ${C} 340)`,
  ];
}

// ---------------------------------------------------------------------------
// buildSemanticTokens — produces the full 84-key SemanticTokenSet for one theme.
// ---------------------------------------------------------------------------

export function buildSemanticTokens(source: ThemeSource): SemanticTokenSet {
  const lanes = gitLanes(source.base);
  const o = (a: number) => overlay(source.base, a);

  return {
    // --- Global Surface (Islands 3-tier) ---
    // backdrop = window frame (sidebar/panel bg level)
    // island   = editor canvas (primary surface)
    // floating = dialogs/menus
    "surface.backdrop.bg": source.bg.secondary,
    "surface.backdrop.fg": source.fg.muted,
    "surface.island.bg": source.bg.primary,
    "surface.island.fg": source.fg.primary,
    "surface.island.border": source.border,
    "surface.island.inactive.veil": o(source.base === "dark" ? 0.2 : 0.04),
    "surface.floating.bg": source.bg.floating,
    "surface.floating.fg": source.fg.primary,
    "surface.floating.border": source.border,
    "surface.floating.scrim": "rgba(0, 0, 0, 0.5)",

    // --- Global State ---
    "state.hover.bg": o(0.04),
    "state.active.bg": o(0.1),
    // state.selected.bg feeds shadcn `--primary`, slider Range/Thumb, checkbox
    // checked state, segmented-control selected segment, settings-dialog nav
    // selected item, primary buttons. ALL of these need to be assertively
    // visible — using lineHighlight (current-row editor tint) here produced
    // an invisible slider on github-light. Use the theme's accent directly.
    "state.selected.bg": source.accent,
    "state.selected.fg": pickContrastFg(source.accent, source.bg.primary),
    "state.selected.indicator": source.accent,
    "state.focus.ring": source.accent,
    "state.disabled.fg": source.fg.muted,
    "state.disabled.bg": o(0.04),
    "state.error.fg": source.error,
    "state.error.border": source.error,
    "state.error.bg": o(0.06),
    "state.warning.fg": source.warning,
    "state.warning.border": source.warning,
    "state.warning.bg": o(0.06),
    "state.loading.indicator": source.accent,
    "state.drag.indicator": source.accent,
    "state.drop.target.bg": o(0.08),

    // --- Global Scrollbar ---
    "scrollbar.thumb.bg": o(0.18),
    "scrollbar.thumb.hover.bg": o(0.28),
    "scrollbar.track.bg": "transparent",

    // --- Global Feedback ---
    "feedback.success.fg": source.success,
    "feedback.success.border": source.success,
    "feedback.success.bg": o(0.06),
    "feedback.info.fg": source.info,
    "feedback.info.border": source.info,
    "feedback.info.bg": o(0.06),

    // --- editor ---
    "editor.text.default": source.fg.primary,
    "editor.text.muted": source.fg.muted,
    "editor.gutter.bg": source.bg.primary,
    "editor.gutter.fg": source.fg.muted,
    "editor.line.highlight": source.lineHighlight,
    "editor.selection.bg": source.selection,
    "editor.cursor.color": source.cursor,
    "editor.find.highlight": source.findHighlight,
    "editor.indent.guide": source.indentGuide,

    // --- sidebar (uses backdrop surface — sidebar lives in the frame layer) ---
    "sidebar.bg": source.bg.secondary,
    "sidebar.fg": source.fg.primary,
    "sidebar.item.hover.bg": o(0.04),
    // sidebar.item.selected.bg stays subtle (sidebar rows pair this with a
    // vertical accent indicator). lineHighlight is too transparent on light
    // themes — use a low-alpha accent overlay so the row is still visible
    // even without focus.
    "sidebar.item.selected.bg": tintedAccent(source.accent, source.bg.secondary, 0.2),
    "sidebar.item.selected.fg": source.fg.primary,
    // sidebar.item.focus.border — dotted 1px outline for the keyboard-focus row
    // in multi-select context (VSCode-parity: focus Trait separate from selection).
    // Uses surface.island.fg at 0.6 alpha so it is readable on both dark/light
    // themes (≥3:1 contrast target against sidebar.item.selected.bg at a=0.20).
    // Kept separate from state.focus.ring so the file tree's focus signal does
    // not collide with global form-control focus styling (design.md §10 separation).
    "sidebar.item.focus.border": withAlpha(source.fg.primary, 0.6),
    "sidebar.icon.fg": source.fg.muted,
    "sidebar.badge.bg": source.accent,
    "sidebar.badge.fg": pickContrastFg(source.accent, source.bg.primary),

    // --- tab ---
    "tab.bar.bg": source.bg.secondary,
    // tab.active.bg는 island surface(source.bg.primary)와 한 단계 차이가 나야
    // 활성 탭이 보인다. 직전까지 bg.primary와 동일 hex를 공유해 fill이 사실상
    // 비가시였고 활성 단서가 텍스트 색 하나로 축약돼 있었음(JetBrains Islands
    // canon이 권장하는 3중 단서 중 1개만 작동). overlay(0.08)은 다크는 흰색 8%
    // 오버레이로 islands보다 살짝 밝게, 라이트는 검정 8%로 살짝 어둡게 만들어
    // ≥1.2:1 대비를 확보한다(state.hover.bg=o(0.04)와도 명확히 구분).
    "tab.active.bg": o(0.08),
    "tab.active.fg": source.fg.primary,
    "tab.active.border": source.accent,
    "tab.inactive.bg": source.bg.secondary,
    "tab.inactive.fg": source.fg.muted,
    "tab.hover.bg": o(0.04),
    "tab.modified.dot": source.accent,
    // Claude status indicators (issue #5 — aliases to existing semantic values)
    // tab.claude.running.fg aliases state.loading.indicator (same accent hue) — no new raw value needed.
    "tab.claude.running.fg": source.accent,
    // tab.claude.attention.fg: info hue, visually distinct from source.warning (SSH connecting yellow).
    // source.info is the per-theme info/cyan/blue; claudeAttentionFg overrides it when source.info
    // fails WCAG 4.5:1 against bg.primary (only solarized-dark requires the override).
    "tab.claude.attention.fg": source.claudeAttentionFg ?? source.info,
    // tab.attention.indicator: inactive tab left 2px bar — uses same attention hue as default.
    // Component switches to state.warning.fg / state.error.fg at runtime per state.
    "tab.attention.indicator": source.claudeAttentionFg ?? source.info,

    // --- panel ---
    "panel.bg": source.bg.primary,
    "panel.fg": source.fg.primary,
    "panel.header.bg": source.bg.secondary,
    "panel.header.fg": source.fg.muted,
    "panel.tab.active.fg": source.fg.primary,
    "panel.tab.inactive.fg": source.fg.muted,
    "panel.border": source.border,

    // --- terminal ---
    "terminal.bg": source.bg.primary,
    "terminal.fg": source.fg.primary,
    "terminal.cursor.color": source.cursor,
    "terminal.cursor.accent": source.bg.primary,
    "terminal.selection.bg": source.selection,

    // --- diff ---
    "diff.added.bg": o(0.06),
    "diff.added.fg": source.success,
    "diff.added.gutter": o(0.1),
    "diff.deleted.bg": o(0.06),
    "diff.deleted.fg": source.error,
    "diff.deleted.gutter": o(0.1),
    "diff.modified.bg": o(0.04),
    "diff.unchanged.fg": source.fg.muted,

    // --- git ---
    "git.lane.0": lanes[0],
    "git.lane.1": lanes[1],
    "git.lane.2": lanes[2],
    "git.lane.3": lanes[3],
    "git.lane.4": lanes[4],
    "git.lane.5": lanes[5],
    "git.lane.6": lanes[6],
    "git.lane.7": lanes[7],
    "git.node.commit.fill": source.accent,
    "git.node.merge.fill": source.success,
    "git.node.tag.fill": source.warning,
    "git.label.branch.bg": source.accent,
    "git.label.branch.fg": pickContrastFg(source.accent, source.bg.primary),
    "git.label.remote.bg": o(0.18),
    "git.label.remote.fg": source.fg.primary,
    "git.status.added.fg": source.success,
    "git.status.modified.fg": source.warning,
    "git.status.deleted.fg": source.error,
    // untracked: VSCode parity — added and untracked both read green. The
    // "new file" semantic is shared; the chip letter (A vs U) carries the
    // distinction. Earlier mapping used `info` (blue) which read as a
    // foreign signal next to the rest of the git palette.
    "git.status.untracked.fg": source.success,
    "git.status.conflict.fg": source.error,
    // renamed: structural change, not a value change — use muted fg so it
    // reads as a secondary signal in the explorer alongside the M/A letters.
    "git.status.renamed.fg": source.fg.muted,
    // ignored: dim the entire row when the file is under .gitignore.
    // Uses muted fg so the file is still readable but visually receded.
    "git.status.ignored.fg": source.fg.muted,

    // --- status bar (uses backdrop layer) ---
    "status.bar.bg": source.bg.secondary,
    "status.bar.fg": source.fg.primary,
    "status.bar.item.hover.bg": o(0.1),
    "status.bar.error.bg": source.error,
    "status.bar.error.fg": source.base === "light" ? "#ffffff" : source.bg.primary,
    "status.bar.warning.bg": source.warning,
    "status.bar.warning.fg": source.bg.primary,
    // Branch changes segment hues — reuse the same source semantics as the
    // editor's git gutter (git.status.*) so "modified" reads identically in
    // both surfaces. fg-only: counts are rendered as colored text on the
    // status bar surface (no chip fill).
    "status.bar.added.fg": source.success,
    "status.bar.modified.fg": source.warning,
    // untracked shares the green hue (see git.status.untracked.fg above).
    "status.bar.untracked.fg": source.success,
    "status.bar.conflict.fg": source.error,

    // --- terminal.ansi 16 keys ---
    "terminal.ansi.black": source.ansi.black,
    "terminal.ansi.red": source.ansi.red,
    "terminal.ansi.green": source.ansi.green,
    "terminal.ansi.yellow": source.ansi.yellow,
    "terminal.ansi.blue": source.ansi.blue,
    "terminal.ansi.magenta": source.ansi.magenta,
    "terminal.ansi.cyan": source.ansi.cyan,
    "terminal.ansi.white": source.ansi.white,
    "terminal.ansi.brightBlack": source.ansi.brightBlack,
    "terminal.ansi.brightRed": source.ansi.brightRed,
    "terminal.ansi.brightGreen": source.ansi.brightGreen,
    "terminal.ansi.brightYellow": source.ansi.brightYellow,
    "terminal.ansi.brightBlue": source.ansi.brightBlue,
    "terminal.ansi.brightMagenta": source.ansi.brightMagenta,
    "terminal.ansi.brightCyan": source.ansi.brightCyan,
    "terminal.ansi.brightWhite": source.ansi.brightWhite,
  };
}

// ---------------------------------------------------------------------------
// buildEditorPalette — produces the Monaco-side EditorPalette for one theme.
// All values returned are 8-digit hex (#rrggbbaa) per Monaco's parser limits.
// ---------------------------------------------------------------------------

export function buildEditorPalette(source: ThemeSource): EditorPalette {
  const fg = source.fg.primary;
  const surface = source.bg.primary;

  // alpha tiers blended against the editor surface so Monaco's parser
  // accepts them (8-digit hex). For overlay backgrounds we mix the fg
  // onto the surface at the given alpha and emit an 8-digit hex with
  // the same alpha embedded — Monaco renders this on top of the
  // editor.background slot, producing the intended tier.
  const tier = (alpha: number): string => alphaOnSurface(fg, surface, alpha);

  return {
    // word highlight
    wordHighlightBackground: tier(0.06),
    wordHighlightStrongBackground: tier(0.12),
    wordHighlightTextBackground: tier(0.04),
    // find/match
    findRangeHighlightBackground: toHex8(source.findHighlight),
    findMatchHighlightBackground: tier(0.1),
    findMatchBackground: toHex8(source.findHighlight, 0.45),
    // peek
    peekViewBorder: toHex8(source.border, 0.8),
    peekViewEditorMatchHighlightBackground: tier(0.2),
    peekViewResultMatchHighlightBackground: tier(0.12),
    peekViewResultBackground: toHex8(source.bg.secondary),
    // link
    linkForeground: toHex8(source.accent),
    linkActiveForeground: toHex8(source.fg.primary),
    // selection
    selectionBackground: toHex8(source.selection),
    inactiveSelectionBackground: tier(0.1),
    selectionHighlightBackground: tier(0.06),
    // widget surfaces
    hoverWidgetBackground: toHex8(source.bg.floating),
    hoverWidgetBorder: toHex8(source.border, 0.5),
    editorWidgetBackground: toHex8(source.bg.floating),
    editorWidgetBorder: toHex8(source.border, 0.8),
    // diagnostic
    errorForeground: toHex8(source.error),
    warningForeground: toHex8(source.warning, 0.85),
    infoForeground: toHex8(source.info),
    hintForeground: toHex8(source.fg.muted, 0.65),
    errorBackground: toHex8(source.error, 0.08),
    warningBackground: toHex8(source.warning, 0.06),
    infoBackground: "#00000000",
    hintBackground: "#00000000",
    // editor surface — fully transparent so the island surface shows through
    editorBackground: "#00000000",
    // syntax — 15 roles per design.md §15.1
    syntaxKeyword: toHex8(source.syntax.keyword),
    syntaxString: toHex8(source.syntax.string),
    syntaxNumber: toHex8(source.syntax.number),
    syntaxComment: toHex8(source.syntax.comment),
    syntaxFunction: toHex8(source.syntax.function),
    syntaxType: toHex8(source.syntax.type),
    syntaxVariable: toHex8(source.syntax.variable),
    syntaxConstant: toHex8(source.syntax.constant),
    syntaxProperty: toHex8(source.syntax.property),
    syntaxOperator: toHex8(source.syntax.operator),
    syntaxTag: toHex8(source.syntax.tag),
    syntaxAttribute: toHex8(source.syntax.attribute),
    syntaxNamespace: toHex8(source.syntax.namespace),
    syntaxRegexp: toHex8(source.syntax.regexp),
    syntaxInvalid: toHex8(source.syntax.invalid),
  };
}
