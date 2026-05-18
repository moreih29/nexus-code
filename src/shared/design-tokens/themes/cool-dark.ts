// themes/cool-dark.ts — Cool Dark theme.
//
// hue: ~240-250 (cool blue-cyan), lightness L0 ≈ 0.18 (identical to warm-dark).
// Surface level structure and inter-level spacing are identical to warm-dark;
// only hue direction changes (warm yellow-green → cool blue-cyan).
// Saturation C is kept near-monochromatic (≤ 0.012 for neutral surfaces),
// matching warm-dark's saturation discipline.
//
// Must satisfy SemanticTokenSet (Record<SemanticKey, string>).
// Missing keys cause TS2741 at compile time.
//
// design.md §8: "Cool Dark(h≈230-260/L0≈0.18, warm-dark와 동일 명도·hue만 반전)"
// design.md §5 5축: "채도 C ≤ 0.012 (near-monochromatic 저채도)"
// design.md §0: "색값의 정본은 src/shared/design-tokens/themes/*.ts"

import type { SemanticTokenSet } from "../semantic";

// Cool Dark surface palette (OKLCH, near-monochromatic blue-tinted neutrals)
// L0 canvas:  oklch(0.18 0.008 245)  — very dark cool-blue-tinted background
// L1 chrome:  oklch(0.22 0.007 245)  — slightly lighter chrome
// L2 panel:   oklch(0.22 0.007 245)  — same as chrome (L1/L2 co-level like warm-dark)
// L3 float:   oklch(0.22 0.007 245)  — floating surfaces match chrome
// bg canvas hex used for xterm API: #191b1f (approx oklch(0.18 0.008 245))
// chrome hex used for Electron titleBarOverlay: #22242a

export const coolDark: SemanticTokenSet = {
  // --- Global Surface (Islands 3-tier) ---
  // backdrop = window frame; lighter than islands in dark themes (≈ #22242a)
  "surface.backdrop.bg": "oklch(0.22 0.007 245)",
  "surface.backdrop.fg": "oklch(0.61 0.006 245)",
  // island = content surfaces; darker than backdrop (≈ #191b1f)
  "surface.island.bg": "oklch(0.18 0.008 245)",
  "surface.island.fg": "oklch(0.96 0.004 240)",
  // island.border = INTERNAL hairline only (never the island's outer edge)
  "surface.island.border": "rgba(200, 210, 240, 0.35)",
  // inactive.veil = backdrop-color overlay; dims unfocused islands toward the frame
  "surface.island.inactive.veil": "rgba(34, 36, 42, 0.55)",
  // L3: floating surfaces
  "surface.floating.bg": "oklch(0.22 0.007 245)",
  "surface.floating.fg": "oklch(0.96 0.004 240)",
  "surface.floating.border": "rgba(200, 210, 240, 0.6)",
  "surface.floating.scrim": "rgba(0, 0, 0, 0.5)",

  // --- Global State ---
  // Dark theme: hover/active overlays are bright direction (white rgba)
  "state.hover.bg": "rgba(200, 210, 255, 0.05)",
  "state.active.bg": "rgba(200, 210, 255, 0.11)",
  // selected: cool-tinted dark equivalent of earthGray (~h245)
  "state.selected.bg": "oklch(0.32 0.008 245)",
  "state.selected.fg": "oklch(0.96 0.004 240)",
  // indicator: cool ash equivalent — L≈0.72, slight cool tint
  "state.selected.indicator": "oklch(0.72 0.006 245)",
  "state.focus.ring": "oklch(0.72 0.006 245)",
  "state.disabled.fg": "oklch(0.52 0.003 245)",
  "state.disabled.bg": "rgba(200, 210, 255, 0.04)",
  // error/warning/loading: hue-agnostic semantic colors (same across themes)
  "state.error.fg": "oklch(0.67 0.245 27.33)",
  "state.error.border": "oklch(0.67 0.245 27.33)",
  "state.error.bg": "rgba(180, 40, 30, 0.12)",
  "state.warning.fg": "oklch(0.76 0.12 82)",
  "state.warning.border": "oklch(0.76 0.12 82)",
  "state.warning.bg": "rgba(180, 130, 20, 0.12)",
  "state.loading.indicator": "oklch(0.72 0.006 245)",
  "state.drag.indicator": "oklch(0.72 0.006 245)",
  "state.drop.target.bg": "rgba(200, 210, 255, 0.08)",

  // --- Global Scrollbar ---
  "scrollbar.thumb.bg": "rgba(200, 210, 240, 0.35)",
  "scrollbar.thumb.hover.bg": "oklch(0.61 0.006 245)",
  "scrollbar.track.bg": "transparent",

  // --- Global Feedback ---
  // Success/info: hue-agnostic semantic colors (same across themes)
  "feedback.success.fg": "oklch(0.72 0.14 145)",
  "feedback.success.border": "oklch(0.72 0.14 145)",
  "feedback.success.bg": "rgba(30, 140, 80, 0.12)",
  "feedback.info.fg": "oklch(0.70 0.10 220)",
  "feedback.info.border": "oklch(0.70 0.10 220)",
  "feedback.info.bg": "rgba(40, 100, 200, 0.12)",

  // --- editor ---
  "editor.text.default": "oklch(0.96 0.004 240)",
  "editor.text.muted": "oklch(0.60 0.006 245)",
  "editor.gutter.bg": "oklch(0.18 0.008 245)",
  "editor.gutter.fg": "oklch(0.59 0.004 245)",
  "editor.line.highlight": "rgba(200, 210, 255, 0.04)",
  "editor.selection.bg": "rgba(200, 210, 255, 0.12)",
  "editor.cursor.color": "oklch(0.96 0.004 240)",
  "editor.find.highlight": "rgba(100, 160, 220, 0.28)",
  "editor.indent.guide": "rgba(200, 210, 240, 0.15)",

  // --- sidebar (island surface) ---
  "sidebar.bg": "oklch(0.18 0.008 245)",
  "sidebar.fg": "oklch(0.96 0.004 240)",
  "sidebar.item.hover.bg": "rgba(200, 210, 255, 0.05)",
  "sidebar.item.selected.bg": "rgba(200, 210, 255, 0.11)",
  "sidebar.item.selected.fg": "oklch(0.96 0.004 240)",
  "sidebar.icon.fg": "oklch(0.61 0.006 245)",
  "sidebar.badge.bg": "oklch(0.32 0.008 245)",
  "sidebar.badge.fg": "oklch(0.96 0.004 240)",

  // --- tab (island surface) ---
  "tab.bar.bg": "oklch(0.18 0.008 245)",
  "tab.active.bg": "oklch(0.18 0.008 245)",
  "tab.active.fg": "oklch(0.96 0.004 240)",
  "tab.active.border": "oklch(0.72 0.006 245)",
  "tab.inactive.bg": "oklch(0.18 0.008 245)",
  "tab.inactive.fg": "oklch(0.61 0.006 245)",
  "tab.hover.bg": "rgba(200, 210, 255, 0.05)",
  "tab.modified.dot": "oklch(0.72 0.006 245)",

  // --- panel (island surface) ---
  "panel.bg": "oklch(0.18 0.008 245)",
  "panel.fg": "oklch(0.96 0.004 240)",
  "panel.header.bg": "oklch(0.18 0.008 245)",
  "panel.header.fg": "oklch(0.61 0.006 245)",
  "panel.tab.active.fg": "oklch(0.96 0.004 240)",
  "panel.tab.inactive.fg": "oklch(0.61 0.006 245)",
  "panel.border": "rgba(200, 210, 240, 0.15)",

  // --- terminal ---
  // terminal.bg must be a literal color for xterm.js background API
  "terminal.bg": "oklch(0.18 0.008 245)",
  "terminal.fg": "oklch(0.96 0.004 240)",
  "terminal.cursor.color": "oklch(0.96 0.004 240)",
  "terminal.cursor.accent": "oklch(0.18 0.008 245)",
  "terminal.selection.bg": "rgba(200, 210, 255, 0.12)",

  // --- diff ---
  "diff.added.bg": "rgba(40, 120, 60, 0.15)",
  "diff.added.fg": "oklch(0.72 0.14 145)",
  "diff.added.gutter": "rgba(40, 120, 60, 0.25)",
  "diff.deleted.bg": "rgba(160, 40, 30, 0.15)",
  "diff.deleted.fg": "oklch(0.64 0.2 27)",
  "diff.deleted.gutter": "rgba(160, 40, 30, 0.25)",
  "diff.modified.bg": "rgba(180, 130, 20, 0.12)",
  "diff.unchanged.fg": "oklch(0.59 0.003 245)",

  // --- git ---
  // Lane hues shifted slightly toward cool spectrum but still spread across hue wheel
  "git.lane.0": "oklch(0.56 0.07 55)",
  "git.lane.1": "oklch(0.58 0.07 180)",
  "git.lane.2": "oklch(0.56 0.07 145)",
  "git.lane.3": "oklch(0.58 0.065 210)",
  "git.lane.4": "oklch(0.56 0.06 250)",
  "git.lane.5": "oklch(0.56 0.065 285)",
  "git.lane.6": "oklch(0.56 0.07 330)",
  "git.lane.7": "oklch(0.56 0.065 25)",
  "git.node.commit.fill": "oklch(0.72 0.006 245)",
  "git.node.merge.fill": "oklch(0.56 0.07 145)",
  "git.node.tag.fill": "oklch(0.58 0.07 180)",
  "git.label.branch.bg": "oklch(0.72 0.006 245)",
  "git.label.branch.fg": "oklch(0.32 0.008 245)",
  "git.label.remote.bg": "rgba(200, 210, 240, 0.35)",
  "git.label.remote.fg": "oklch(0.96 0.004 240)",
  "git.status.added.fg": "oklch(0.72 0.14 145)",
  "git.status.modified.fg": "oklch(0.76 0.12 82)",
  "git.status.deleted.fg": "oklch(0.64 0.2 27)",
  "git.status.untracked.fg": "oklch(0.70 0.10 220)",
  "git.status.conflict.fg": "oklch(0.68 0.19 27)",

  // --- status bar ---
  "status.bar.bg": "oklch(0.22 0.007 245)",
  "status.bar.fg": "oklch(0.96 0.004 240)",
  "status.bar.item.hover.bg": "rgba(200, 210, 255, 0.11)",
  "status.bar.error.bg": "oklch(0.67 0.245 27.33)",
  "status.bar.error.fg": "oklch(0.96 0.004 240)",
  "status.bar.warning.bg": "oklch(0.76 0.12 82)",
  "status.bar.warning.fg": "oklch(0.18 0.008 245)",

  // --- terminal.ansi 16 keys ---
  // Re-tuned for cool-dark L0 background oklch(0.18, 0.008, 245).
  // All normal colors target L≥0.55 for ≥3:1 contrast vs L0≈0.18.
  // Bright variants target L≥0.68 for stronger legibility.
  // Blue shifted toward cyan (h≈200-220) to be distinguishable from background hue.
  "terminal.ansi.black": "oklch(0.18 0.008 245)",
  "terminal.ansi.red": "oklch(0.58 0.22 27)",
  "terminal.ansi.green": "oklch(0.65 0.17 145)",
  "terminal.ansi.yellow": "oklch(0.76 0.12 82)",
  "terminal.ansi.blue": "oklch(0.60 0.10 200)",
  "terminal.ansi.magenta": "oklch(0.58 0.10 305)",
  "terminal.ansi.cyan": "oklch(0.68 0.10 195)",
  "terminal.ansi.white": "oklch(0.78 0.004 240)",
  "terminal.ansi.brightBlack": "oklch(0.51 0.005 245)",
  "terminal.ansi.brightRed": "oklch(0.65 0.23 27)",
  "terminal.ansi.brightGreen": "oklch(0.72 0.14 145)",
  "terminal.ansi.brightYellow": "oklch(0.82 0.10 90)",
  "terminal.ansi.brightBlue": "oklch(0.70 0.10 200)",
  "terminal.ansi.brightMagenta": "oklch(0.68 0.10 305)",
  "terminal.ansi.brightCyan": "oklch(0.76 0.10 195)",
  "terminal.ansi.brightWhite": "oklch(0.96 0.004 240)",
};
