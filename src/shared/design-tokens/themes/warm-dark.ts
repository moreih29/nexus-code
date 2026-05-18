// themes/warm-dark.ts — Warm Dark theme (flagship, default).
//
// hue: ~90-110 (warm yellow-green), lightness L0 ≈ 0.18.
// All values are derived from the existing Warm Parchment / Earth Gray palette
// that was previously in-lined in buildSemanticTokens().
//
// Must satisfy SemanticTokenSet (Record<SemanticKey, string>).
// Missing keys cause TS2741 at compile time.
//
// Color values only — no structural decisions, no shadcn var names here.
// design.md: §0 "색값의 정본은 src/shared/design-tokens/themes/*.ts"

import type { SemanticTokenSet } from "../semantic";

export const warmDark: SemanticTokenSet = {
  // --- Global Surface (Islands 3-tier) ---
  // backdrop = window frame; lighter than islands in dark themes (design.md §2)
  "surface.backdrop.bg": "#252422",
  "surface.backdrop.fg": "oklch(0.638 0.0019 67.79)",
  // island = content surfaces; darker than backdrop so islands sink into the frame
  "surface.island.bg": "#1a1917",
  "surface.island.fg": "oklch(0.982 0.0041 91.45)",
  // island.border = INTERNAL hairline only (never the island's outer edge)
  "surface.island.border": "rgba(226, 226, 226, 0.35)",
  // inactive.veil = backdrop-color overlay; dims unfocused islands toward the frame
  "surface.island.inactive.veil": "rgba(37, 36, 34, 0.55)",
  "surface.floating.bg": "#252422",
  "surface.floating.fg": "oklch(0.982 0.0041 91.45)",
  "surface.floating.border": "rgba(226, 226, 226, 0.6)",
  "surface.floating.scrim": "rgba(0, 0, 0, 0.5)",

  // --- Global State ---
  "state.hover.bg": "rgba(255, 255, 255, 0.04)",
  "state.active.bg": "rgba(255, 255, 255, 0.1)",
  "state.selected.bg": "oklch(0.3286 0.0017 106.49)",
  "state.selected.fg": "oklch(0.982 0.0041 91.45)",
  "state.selected.indicator": "oklch(0.751 0.0031 84.56)",
  "state.focus.ring": "oklch(0.751 0.0031 84.56)",
  "state.disabled.fg": "oklch(0.54 0 0)",
  "state.disabled.bg": "rgba(255, 255, 255, 0.04)",
  "state.error.fg": "oklch(0.67 0.245 27.33)",
  "state.error.border": "oklch(0.67 0.245 27.33)",
  "state.error.bg": "rgba(180, 40, 30, 0.12)",
  "state.warning.fg": "oklch(0.76 0.12 82)",
  "state.warning.border": "oklch(0.76 0.12 82)",
  "state.warning.bg": "rgba(180, 130, 20, 0.12)",
  "state.loading.indicator": "oklch(0.751 0.0031 84.56)",
  "state.drag.indicator": "oklch(0.751 0.0031 84.56)",
  "state.drop.target.bg": "rgba(255, 255, 255, 0.08)",

  // --- Global Scrollbar ---
  "scrollbar.thumb.bg": "rgba(226, 226, 226, 0.35)",
  "scrollbar.thumb.hover.bg": "oklch(0.6173 0.0019 67.79)",
  "scrollbar.track.bg": "transparent",

  // --- Global Feedback ---
  "feedback.success.fg": "oklch(0.72 0.14 145)",
  "feedback.success.border": "oklch(0.72 0.14 145)",
  "feedback.success.bg": "rgba(30, 140, 80, 0.12)",
  "feedback.info.fg": "oklch(0.68 0.1 220)",
  "feedback.info.border": "oklch(0.68 0.1 220)",
  "feedback.info.bg": "rgba(40, 100, 200, 0.12)",

  // --- editor ---
  "editor.text.default": "oklch(0.982 0.0041 91.45)",
  "editor.text.muted": "oklch(0.6173 0.0019 67.79)",
  "editor.gutter.bg": "#1a1917",
  "editor.gutter.fg": "oklch(0.61 0 0)",
  "editor.line.highlight": "rgba(255, 255, 255, 0.04)",
  "editor.selection.bg": "rgba(255, 255, 255, 0.1)",
  "editor.cursor.color": "oklch(0.982 0.0041 91.45)",
  "editor.find.highlight": "rgba(200, 180, 100, 0.25)",
  "editor.indent.guide": "rgba(226, 226, 226, 0.15)",

  // --- sidebar (island surface) ---
  "sidebar.bg": "#1a1917",
  "sidebar.fg": "oklch(0.982 0.0041 91.45)",
  "sidebar.item.hover.bg": "rgba(255, 255, 255, 0.04)",
  "sidebar.item.selected.bg": "rgba(255, 255, 255, 0.1)",
  "sidebar.item.selected.fg": "oklch(0.982 0.0041 91.45)",
  "sidebar.icon.fg": "oklch(0.638 0.0019 67.79)",
  "sidebar.badge.bg": "oklch(0.3286 0.0017 106.49)",
  "sidebar.badge.fg": "oklch(0.982 0.0041 91.45)",

  // --- tab (island surface) ---
  "tab.bar.bg": "#1a1917",
  "tab.active.bg": "#1a1917",
  "tab.active.fg": "oklch(0.982 0.0041 91.45)",
  "tab.active.border": "oklch(0.751 0.0031 84.56)",
  "tab.inactive.bg": "#1a1917",
  "tab.inactive.fg": "oklch(0.638 0.0019 67.79)",
  "tab.hover.bg": "rgba(255, 255, 255, 0.04)",
  "tab.modified.dot": "oklch(0.751 0.0031 84.56)",

  // --- panel (island surface) ---
  "panel.bg": "#1a1917",
  "panel.fg": "oklch(0.982 0.0041 91.45)",
  "panel.header.bg": "#1a1917",
  "panel.header.fg": "oklch(0.638 0.0019 67.79)",
  "panel.tab.active.fg": "oklch(0.982 0.0041 91.45)",
  "panel.tab.inactive.fg": "oklch(0.638 0.0019 67.79)",
  "panel.border": "rgba(226, 226, 226, 0.15)",

  // --- terminal ---
  "terminal.bg": "#1a1917",
  "terminal.fg": "oklch(0.982 0.0041 91.45)",
  "terminal.cursor.color": "oklch(0.982 0.0041 91.45)",
  "terminal.cursor.accent": "#1a1917",
  "terminal.selection.bg": "rgba(255, 255, 255, 0.1)",

  // --- diff ---
  "diff.added.bg": "rgba(40, 120, 60, 0.15)",
  "diff.added.fg": "oklch(0.72 0.14 145)",
  "diff.added.gutter": "rgba(40, 120, 60, 0.25)",
  "diff.deleted.bg": "rgba(160, 40, 30, 0.15)",
  "diff.deleted.fg": "oklch(0.66 0.2 27)",
  "diff.deleted.gutter": "rgba(160, 40, 30, 0.25)",
  "diff.modified.bg": "rgba(180, 130, 20, 0.12)",
  "diff.unchanged.fg": "oklch(0.61 0 0)",

  // --- git ---
  "git.lane.0": "oklch(0.56 0.07 55)",
  "git.lane.1": "oklch(0.56 0.075 95)",
  "git.lane.2": "oklch(0.56 0.07 145)",
  "git.lane.3": "oklch(0.56 0.065 190)",
  "git.lane.4": "oklch(0.56 0.06 235)",
  "git.lane.5": "oklch(0.56 0.065 285)",
  "git.lane.6": "oklch(0.56 0.07 330)",
  "git.lane.7": "oklch(0.56 0.065 25)",
  "git.node.commit.fill": "oklch(0.751 0.0031 84.56)",
  "git.node.merge.fill": "oklch(0.56 0.07 145)",
  "git.node.tag.fill": "oklch(0.56 0.075 95)",
  "git.label.branch.bg": "oklch(0.751 0.0031 84.56)",
  "git.label.branch.fg": "oklch(0.3286 0.0017 106.49)",
  "git.label.remote.bg": "rgba(226, 226, 226, 0.35)",
  "git.label.remote.fg": "oklch(0.982 0.0041 91.45)",
  "git.status.added.fg": "oklch(0.72 0.14 145)",
  "git.status.modified.fg": "oklch(0.76 0.12 82)",
  "git.status.deleted.fg": "oklch(0.66 0.2 27)",
  "git.status.untracked.fg": "oklch(0.68 0.1 220)",
  "git.status.conflict.fg": "oklch(0.68 0.19 27)",

  // --- status bar ---
  "status.bar.bg": "#252422",
  "status.bar.fg": "oklch(0.982 0.0041 91.45)",
  "status.bar.item.hover.bg": "rgba(255, 255, 255, 0.1)",
  "status.bar.error.bg": "oklch(0.67 0.245 27.33)",
  "status.bar.error.fg": "oklch(0.982 0.0041 91.45)",
  "status.bar.warning.bg": "oklch(0.76 0.12 82)",
  "status.bar.warning.fg": "#1a1917",

  // --- terminal.ansi 16 keys ---
  "terminal.ansi.black": "#1a1917",
  "terminal.ansi.red": "oklch(0.577 0.245 27.33)",
  "terminal.ansi.green": "oklch(0.65 0.17 145)",
  "terminal.ansi.yellow": "oklch(0.76 0.12 82)",
  "terminal.ansi.blue": "oklch(0.56 0.06 235)",
  "terminal.ansi.magenta": "oklch(0.5067 0.0082 304.11)",
  "terminal.ansi.cyan": "oklch(0.68 0.1 200)",
  "terminal.ansi.white": "oklch(0.78 0.0019 67.79)",
  "terminal.ansi.brightBlack": "oklch(0.52 0.001 84)",
  "terminal.ansi.brightRed": "oklch(0.65 0.25 27.33)",
  "terminal.ansi.brightGreen": "oklch(0.72 0.14 145)",
  "terminal.ansi.brightYellow": "oklch(0.82 0.1 90)",
  "terminal.ansi.brightBlue": "oklch(0.65 0.07 235)",
  "terminal.ansi.brightMagenta": "oklch(0.6 0.01 304.11)",
  "terminal.ansi.brightCyan": "oklch(0.75 0.1 200)",
  "terminal.ansi.brightWhite": "oklch(0.982 0.0041 91.45)",
};
