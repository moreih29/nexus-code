// themes/warm-light.ts — Warm Light theme.
//
// hue: ~90-110 (warm yellow-green — identical hue family to warm-dark).
// L0 ≈ 0.96 (near-white, not pure #fff — hue-tinted near-white).
// Surface levels inverted relative to warm-dark:
//   L0 (canvas):  lightest surface (highest lightness)
//   L1 (chrome):  slightly darker than canvas
//   L2 (panel):   same level as chrome
//   L3 (floating): slightly darker than panel (visible elevation)
//
// Overlay direction: DARK rgba (not white) — design.md §7 & §10.
// "다크 테마에서 hover/active 오버레이는 밝은 방향(흰색 rgba)으로 작동한다.
//  라이트 테마에서는 어두운 방향으로 반전되어야 한다."
//
// hairline borders: more opaque than dark theme to prevent zone loss on light.
//
// Must satisfy SemanticTokenSet (Record<SemanticKey, string>).
// Missing keys cause TS2741 at compile time.
//
// design.md §8: "Warm Light(h≈90-110, warm-dark와 동일 hue 패밀리/L0≈0.96)"
// design.md §10: hover/active overlays must be dark direction for light theme.
// design.md §0: "색값의 정본은 src/shared/design-tokens/themes/*.ts"

import type { SemanticTokenSet } from "../semantic";

// Warm Light surface palette (OKLCH, near-monochromatic warm-tinted neutrals)
// L0 canvas:  oklch(0.965 0.005 95)  — near-white warm-tinted (not pure white)
// L1 chrome:  oklch(0.935 0.005 95)  — slightly darker, same hue family
// L2 panel:   oklch(0.935 0.005 95)  — co-level with chrome (same as warm-dark L1/L2)
// L3 float:   oklch(0.950 0.004 95)  — slightly lighter than chrome for elevation
// dark fg:    oklch(0.22 0.008 100)  — near-black warm-tinted (not pure #000)
// muted fg:   oklch(0.48 0.006 95)   — mid-tone, warm-tinted stone

export const warmLight: SemanticTokenSet = {
  // --- Global Surface ---
  // L0: near-white warm canvas
  "surface.canvas.bg": "oklch(0.965 0.005 95)",
  // dark warm-tinted foreground for L0
  "surface.canvas.fg": "oklch(0.22 0.008 100)",
  // L1: chrome slightly darker than canvas
  "surface.chrome.bg": "oklch(0.935 0.005 95)",
  // muted foreground — warm mid-tone
  "surface.chrome.fg": "oklch(0.48 0.006 95)",
  // chrome hairline — dark translucent for visible zone boundary on light surface
  "surface.chrome.border": "rgba(50, 45, 30, 0.18)",
  // L2: panel at chrome level
  "surface.panel.bg": "oklch(0.935 0.005 95)",
  "surface.panel.fg": "oklch(0.22 0.008 100)",
  // panel border — more opaque than chrome to maintain zone separation
  "surface.panel.border": "rgba(50, 45, 30, 0.28)",
  // L3: floating slightly lighter (higher) than chrome — visible elevation
  "surface.floating.bg": "oklch(0.950 0.004 95)",
  "surface.floating.fg": "oklch(0.22 0.008 100)",
  // floating border — strongest hairline, surface contrast + hairline = elevation
  "surface.floating.border": "rgba(50, 45, 30, 0.42)",
  // scrim: semi-transparent dark (dark overlay on light bg — same direction as overlay)
  "surface.floating.scrim": "rgba(30, 25, 15, 0.45)",

  // --- Global State ---
  // Light theme: hover/active overlays are DARK direction (dark rgba, not white)
  "state.hover.bg": "rgba(26, 25, 15, 0.06)",
  "state.active.bg": "rgba(26, 25, 15, 0.12)",
  // selected: warm-tinted dark equivalent — earthGray equivalent for light bg
  "state.selected.bg": "oklch(0.3286 0.0017 106.49)",
  "state.selected.fg": "oklch(0.965 0.005 95)",
  // indicator: warm ash equivalent visible on light background
  "state.selected.indicator": "oklch(0.42 0.008 100)",
  // focus ring: must be ≥ 3:1 contrast vs light background — use dark warm
  "state.focus.ring": "oklch(0.42 0.008 100)",
  "state.disabled.fg": "oklch(0.60 0.003 95)",
  "state.disabled.bg": "rgba(26, 25, 15, 0.05)",
  // error/warning: same semantic colors — contrast verified against light bg
  // error L≈0.47 vs L0≈0.965 → contrast ≈ 4.8:1 (WCAG AA)
  "state.error.fg": "oklch(0.47 0.22 27)",
  "state.error.border": "oklch(0.47 0.22 27)",
  "state.error.bg": "rgba(160, 30, 20, 0.09)",
  // warning L≈0.52 vs L0≈0.965 → contrast ≈ 5.08:1 (WCAG AA, adjusted for light)
  "state.warning.fg": "oklch(0.52 0.14 82)",
  "state.warning.border": "oklch(0.52 0.14 82)",
  "state.warning.bg": "rgba(140, 100, 10, 0.09)",
  "state.loading.indicator": "oklch(0.42 0.008 100)",

  // --- Global Feedback ---
  // Success/info adjusted for light background — darker to maintain contrast
  "feedback.success.fg": "oklch(0.48 0.16 145)",
  "feedback.success.border": "oklch(0.48 0.16 145)",
  "feedback.success.bg": "rgba(20, 110, 60, 0.09)",
  "feedback.info.fg": "oklch(0.46 0.12 220)",
  "feedback.info.border": "oklch(0.46 0.12 220)",
  "feedback.info.bg": "rgba(30, 80, 180, 0.09)",

  // --- editor ---
  // Editor on L0 canvas — dark text on near-white bg
  "editor.text.default": "oklch(0.22 0.008 100)",
  "editor.text.muted": "oklch(0.50 0.005 95)",
  "editor.gutter.bg": "oklch(0.965 0.005 95)",
  "editor.gutter.fg": "oklch(0.50 0.004 95)",
  // line highlight: subtle dark overlay on light canvas
  "editor.line.highlight": "rgba(26, 25, 15, 0.05)",
  "editor.selection.bg": "rgba(26, 25, 15, 0.12)",
  "editor.cursor.color": "oklch(0.22 0.008 100)",
  // find highlight: warm amber tint, visible on light bg
  "editor.find.highlight": "rgba(180, 140, 20, 0.28)",
  "editor.indent.guide": "rgba(50, 45, 30, 0.18)",

  // --- sidebar ---
  "sidebar.bg": "oklch(0.935 0.005 95)",
  "sidebar.fg": "oklch(0.22 0.008 100)",
  "sidebar.item.hover.bg": "rgba(26, 25, 15, 0.06)",
  "sidebar.item.selected.bg": "rgba(26, 25, 15, 0.12)",
  "sidebar.item.selected.fg": "oklch(0.22 0.008 100)",
  "sidebar.icon.fg": "oklch(0.48 0.006 95)",
  "sidebar.badge.bg": "oklch(0.3286 0.0017 106.49)",
  "sidebar.badge.fg": "oklch(0.965 0.005 95)",

  // --- tab ---
  "tab.bar.bg": "oklch(0.935 0.005 95)",
  // active tab: canvas-level (lighter) to show elevation above tab bar
  "tab.active.bg": "oklch(0.965 0.005 95)",
  "tab.active.fg": "oklch(0.22 0.008 100)",
  "tab.active.border": "oklch(0.42 0.008 100)",
  "tab.inactive.bg": "oklch(0.935 0.005 95)",
  "tab.inactive.fg": "oklch(0.50 0.005 95)",
  "tab.hover.bg": "rgba(26, 25, 15, 0.06)",
  "tab.modified.dot": "oklch(0.42 0.008 100)",

  // --- panel ---
  "panel.bg": "oklch(0.935 0.005 95)",
  "panel.fg": "oklch(0.22 0.008 100)",
  "panel.header.bg": "oklch(0.935 0.005 95)",
  "panel.header.fg": "oklch(0.48 0.006 95)",
  "panel.tab.active.fg": "oklch(0.22 0.008 100)",
  "panel.tab.inactive.fg": "oklch(0.50 0.005 95)",
  "panel.border": "rgba(50, 45, 30, 0.18)",

  // --- terminal ---
  // Terminal sits at L0 (canvas level) but as a dark terminal on light chrome,
  // we keep terminal.bg as a literal dark value — terminals are typically dark.
  // The terminal region is the only allowed L0 "inverted" zone in light theme.
  "terminal.bg": "#1a1917",
  "terminal.fg": "oklch(0.965 0.005 95)",
  "terminal.cursor.color": "oklch(0.965 0.005 95)",
  "terminal.cursor.accent": "#1a1917",
  "terminal.selection.bg": "rgba(255, 255, 255, 0.12)",

  // --- diff ---
  // Diff colors on light canvas must be darker than warm-dark equivalents
  "diff.added.bg": "rgba(20, 100, 50, 0.12)",
  "diff.added.fg": "oklch(0.42 0.18 145)",
  "diff.added.gutter": "rgba(20, 100, 50, 0.22)",
  "diff.deleted.bg": "rgba(150, 30, 20, 0.12)",
  "diff.deleted.fg": "oklch(0.44 0.22 27)",
  "diff.deleted.gutter": "rgba(150, 30, 20, 0.22)",
  "diff.modified.bg": "rgba(140, 100, 10, 0.10)",
  "diff.unchanged.fg": "oklch(0.50 0.003 95)",

  // --- git ---
  // Lane colors: darker variants for light background (L≈0.46-0.50 vs L0≈0.965)
  // All lanes target contrast ≥ 3:1 against canvas background.
  "git.lane.0": "oklch(0.48 0.09 55)",
  "git.lane.1": "oklch(0.48 0.09 95)",
  "git.lane.2": "oklch(0.48 0.09 145)",
  "git.lane.3": "oklch(0.48 0.085 190)",
  "git.lane.4": "oklch(0.48 0.08 235)",
  "git.lane.5": "oklch(0.48 0.085 285)",
  "git.lane.6": "oklch(0.48 0.09 330)",
  "git.lane.7": "oklch(0.48 0.085 25)",
  "git.node.commit.fill": "oklch(0.42 0.008 100)",
  "git.node.merge.fill": "oklch(0.48 0.09 145)",
  "git.node.tag.fill": "oklch(0.48 0.09 95)",
  "git.label.branch.bg": "oklch(0.3286 0.0017 106.49)",
  "git.label.branch.fg": "oklch(0.965 0.005 95)",
  "git.label.remote.bg": "rgba(50, 45, 30, 0.20)",
  "git.label.remote.fg": "oklch(0.22 0.008 100)",
  "git.status.added.fg": "oklch(0.42 0.18 145)",
  "git.status.modified.fg": "oklch(0.48 0.16 82)",
  "git.status.deleted.fg": "oklch(0.44 0.22 27)",
  "git.status.untracked.fg": "oklch(0.46 0.12 220)",
  "git.status.conflict.fg": "oklch(0.44 0.20 27)",

  // --- status bar ---
  "status.bar.bg": "oklch(0.935 0.005 95)",
  "status.bar.fg": "oklch(0.22 0.008 100)",
  "status.bar.item.hover.bg": "rgba(26, 25, 15, 0.12)",
  "status.bar.error.bg": "oklch(0.47 0.22 27)",
  "status.bar.error.fg": "oklch(0.965 0.005 95)",
  "status.bar.warning.bg": "oklch(0.52 0.14 82)",
  "status.bar.warning.fg": "oklch(0.965 0.005 95)",

  // --- terminal.ansi 16 keys ---
  // Terminal uses dark background (#1a1917) — same as warm-dark ANSI palette.
  // The terminal is an inverted region in light theme; its ANSI colors need
  // contrast against the dark terminal.bg, not the light canvas.
  // Reuse warm-dark ANSI values — they were tuned for dark bg.
  // design.md §10: "terminal.ansi.* 16키 — 라이트 배경에서 blue/red가 대비 3:1 이상"
  // Since terminal.bg = #1a1917 (same dark bg), warm-dark ANSI values apply.
  "terminal.ansi.black": "#1a1917",
  "terminal.ansi.red": "oklch(0.577 0.245 27.33)",
  "terminal.ansi.green": "oklch(0.65 0.17 145)",
  "terminal.ansi.yellow": "oklch(0.76 0.12 82)",
  "terminal.ansi.blue": "oklch(0.60 0.08 235)",
  "terminal.ansi.magenta": "oklch(0.58 0.09 305)",
  "terminal.ansi.cyan": "oklch(0.68 0.10 200)",
  "terminal.ansi.white": "oklch(0.78 0.0019 67.79)",
  "terminal.ansi.brightBlack": "oklch(0.52 0.001 84)",
  "terminal.ansi.brightRed": "oklch(0.65 0.25 27.33)",
  "terminal.ansi.brightGreen": "oklch(0.72 0.14 145)",
  "terminal.ansi.brightYellow": "oklch(0.82 0.10 90)",
  "terminal.ansi.brightBlue": "oklch(0.70 0.09 235)",
  "terminal.ansi.brightMagenta": "oklch(0.68 0.09 305)",
  "terminal.ansi.brightCyan": "oklch(0.75 0.10 200)",
  "terminal.ansi.brightWhite": "oklch(0.982 0.0041 91.45)",
};
