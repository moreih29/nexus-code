// semantic.ts — SemanticKey vocabulary + empty-key contract.
//
// This file defines ONLY types. It holds no color values.
// Every SemanticKey entry corresponds 1:1 with design.md §10 Region Semantics.
//
// SEALED constants (--shadow-*, --radius) are NOT in SemanticKey —
// they are managed in component.ts so themes cannot override them.
//
// Consumers:
//   themes/*.ts     → must satisfy Record<SemanticKey, string> (TS2741 on miss)
//   component.ts    → buildShadcnVars() maps SemanticKey → shadcn var names
//   generate-theme-css.ts → emits SemanticKey tokens as CSS custom properties

// ---------------------------------------------------------------------------
// SemanticKey — flat string union, region.element.role naming convention
// design.md §10 vocabulary freeze (1:1 correspondence required)
// ---------------------------------------------------------------------------

export type SemanticKey =
  // --- Global Surface (Islands 3-tier: backdrop / island / floating, 10 keys) ---
  | "surface.backdrop.bg"
  | "surface.backdrop.fg"
  | "surface.island.bg"
  | "surface.island.fg"
  | "surface.island.border"
  | "surface.island.inactive.veil"
  | "surface.floating.bg"
  | "surface.floating.fg"
  | "surface.floating.border"
  | "surface.floating.scrim"

  // --- Global State (17 keys) ---
  | "state.hover.bg"
  | "state.active.bg"
  | "state.selected.bg"
  | "state.selected.fg"
  | "state.selected.indicator"
  | "state.focus.ring"
  | "state.disabled.fg"
  | "state.disabled.bg"
  | "state.error.fg"
  | "state.error.border"
  | "state.error.bg"
  | "state.warning.fg"
  | "state.warning.border"
  | "state.warning.bg"
  | "state.loading.indicator"
  | "state.drag.indicator"
  | "state.drop.target.bg"

  // --- Global Scrollbar (3 keys) ---
  | "scrollbar.thumb.bg"
  | "scrollbar.thumb.hover.bg"
  | "scrollbar.track.bg"

  // --- Global Feedback (6 keys) ---
  | "feedback.success.fg"
  | "feedback.success.border"
  | "feedback.success.bg"
  | "feedback.info.fg"
  | "feedback.info.border"
  | "feedback.info.bg"

  // --- IDE Region: editor (9 keys) ---
  | "editor.text.default"
  | "editor.text.muted"
  | "editor.gutter.bg"
  | "editor.gutter.fg"
  | "editor.line.highlight"
  | "editor.selection.bg"
  | "editor.cursor.color"
  | "editor.find.highlight"
  | "editor.indent.guide"

  // --- IDE Region: sidebar (9 keys) ---
  | "sidebar.bg"
  | "sidebar.fg"
  | "sidebar.item.hover.bg"
  | "sidebar.item.selected.bg"
  | "sidebar.item.selected.fg"
  | "sidebar.icon.fg"
  | "sidebar.badge.bg"
  | "sidebar.badge.fg"

  // --- IDE Region: tab (11 keys) ---
  | "tab.bar.bg"
  | "tab.active.bg"
  | "tab.active.fg"
  | "tab.active.border"
  | "tab.inactive.bg"
  | "tab.inactive.fg"
  | "tab.hover.bg"
  | "tab.modified.dot"
  // Claude status indicators (issue #5 — designer decision)
  | "tab.claude.running.fg"     // loader glyph color in running state (info/accent hue)
  | "tab.claude.attention.fg"   // needsInput glyph color — info hue, visually distinct from SSH connecting yellow
  | "tab.attention.indicator"   // inactive tab left 2px bar — info/warning/error, dynamic per state at component level

  // --- IDE Region: panel (7 keys) ---
  | "panel.bg"
  | "panel.fg"
  | "panel.header.bg"
  | "panel.header.fg"
  | "panel.tab.active.fg"
  | "panel.tab.inactive.fg"
  | "panel.border"

  // --- IDE Region: terminal (5 keys) ---
  | "terminal.bg"
  | "terminal.fg"
  | "terminal.cursor.color"
  | "terminal.cursor.accent"
  | "terminal.selection.bg"

  // --- IDE Region: diff (8 keys) ---
  | "diff.added.bg"
  | "diff.added.fg"
  | "diff.added.gutter"
  | "diff.deleted.bg"
  | "diff.deleted.fg"
  | "diff.deleted.gutter"
  | "diff.modified.bg"
  | "diff.unchanged.fg"

  // --- IDE Region: git (21 keys) ---
  | "git.lane.0"
  | "git.lane.1"
  | "git.lane.2"
  | "git.lane.3"
  | "git.lane.4"
  | "git.lane.5"
  | "git.lane.6"
  | "git.lane.7"
  | "git.node.commit.fill"
  | "git.node.merge.fill"
  | "git.node.tag.fill"
  | "git.label.branch.bg"
  | "git.label.branch.fg"
  | "git.label.remote.bg"
  | "git.label.remote.fg"
  | "git.status.added.fg"
  | "git.status.modified.fg"
  | "git.status.deleted.fg"
  | "git.status.untracked.fg"
  | "git.status.conflict.fg"

  // --- IDE Region: status bar (11 keys) ---
  | "status.bar.bg"
  | "status.bar.fg"
  | "status.bar.item.hover.bg"
  | "status.bar.error.bg"
  | "status.bar.error.fg"
  | "status.bar.warning.bg"
  | "status.bar.warning.fg"
  // Branch changes segment — count chips next to the branch indicator.
  // Each maps to the same semantic hue as the editor's git gutter so a file
  // marked "modified" in the diff reads the same color in the status bar.
  | "status.bar.added.fg"      // `+N` staged
  | "status.bar.modified.fg"   // `~N` working (unstaged modify/delete)
  | "status.bar.untracked.fg"  // `?N` untracked (new file)
  | "status.bar.conflict.fg"   // `!N` merge conflict (priority — rendered first)

  // --- terminal.ansi.* 16 ANSI palette keys ---
  | "terminal.ansi.black"
  | "terminal.ansi.red"
  | "terminal.ansi.green"
  | "terminal.ansi.yellow"
  | "terminal.ansi.blue"
  | "terminal.ansi.magenta"
  | "terminal.ansi.cyan"
  | "terminal.ansi.white"
  | "terminal.ansi.brightBlack"
  | "terminal.ansi.brightRed"
  | "terminal.ansi.brightGreen"
  | "terminal.ansi.brightYellow"
  | "terminal.ansi.brightBlue"
  | "terminal.ansi.brightMagenta"
  | "terminal.ansi.brightCyan"
  | "terminal.ansi.brightWhite";

// ---------------------------------------------------------------------------
// SemanticTokenSet — the complete filled token map that themes must satisfy.
// Record<SemanticKey, string> causes TS2741 at compile-time if any key is missing.
// ---------------------------------------------------------------------------

export type SemanticTokenSet = Record<SemanticKey, string>;
