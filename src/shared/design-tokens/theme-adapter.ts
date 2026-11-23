import { converter, formatHex8, parse } from "culori";
import type { SemanticTokenSet } from "./semantic";
import type { ThemeSource } from "./theme-sources";

const toRgb = converter("rgb");

function pickContrastFg(bg: string, darkChoice: string): string {
  const parsed = parse(bg);
  if (!parsed) return "#ffffff";
  const rgb = toRgb(parsed);
  if (!rgb) return "#ffffff";
  const lum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return lum > 0.55 ? darkChoice : "#ffffff";
}

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

export interface EditorPalette {
  wordHighlightBackground: string;
  wordHighlightStrongBackground: string;
  wordHighlightTextBackground: string;
  findRangeHighlightBackground: string;
  findMatchHighlightBackground: string;
  findMatchBackground: string;
  peekViewBorder: string;
  peekViewEditorMatchHighlightBackground: string;
  peekViewResultMatchHighlightBackground: string;
  peekViewResultBackground: string;
  linkActiveForeground: string;
  selectionBackground: string;
  inactiveSelectionBackground: string;
  selectionHighlightBackground: string;
  hoverWidgetBackground: string;
  hoverWidgetBorder: string;
  editorWidgetBackground: string;
  editorWidgetBorder: string;
  errorForeground: string;
  warningForeground: string;
  infoForeground: string;
  hintForeground: string;
  errorBackground: string;
  warningBackground: string;
  infoBackground: string;
  hintBackground: string;
  editorBackground: string;
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

function toHex8(value: string, alphaOverride?: number): string {
  const parsed = parse(value);
  if (!parsed) {
    return value;
  }
  if (alphaOverride !== undefined) {
    return formatHex8({ ...parsed, alpha: alphaOverride }) ?? value;
  }
  return formatHex8(parsed) ?? value;
}

function scaleAlpha(value: string, factor: number): string {
  const parsed = parse(value);
  if (!parsed) return value;
  return formatHex8({ ...parsed, alpha: (parsed.alpha ?? 1) * factor }) ?? value;
}

function overlay(base: "dark" | "light", alpha: number): string {
  const rgb = base === "dark" ? "255, 255, 255" : "0, 0, 0";
  return `rgba(${rgb}, ${alpha})`;
}

function shadeScaled(alpha: number, cssVar: string, fallback: number): string {
  return `rgba(0, 0, 0, calc(${alpha} * var(${cssVar}, ${fallback})))`;
}

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

function gitLanes(
  base: "dark" | "light",
): readonly [string, string, string, string, string, string, string, string] {
  const L = base === "dark" ? 0.66 : 0.52;
  const C = base === "dark" ? 0.13 : 0.14;
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

export function buildSemanticTokens(source: ThemeSource): SemanticTokenSet {
  const lanes = gitLanes(source.base);
  const o = (a: number) => overlay(source.base, a);

  return {
    "surface.backdrop.bg": source.bg.secondary,
    "surface.backdrop.fg": source.fg.muted,
    "surface.island.bg": source.bg.primary,
    "surface.island.fg": source.fg.primary,
    "surface.island.border": source.border,
    "surface.island.inactive.veil": shadeScaled(
      source.base === "dark" ? 0.28 : 0.04,
      "--inactive-panel-dim",
      1,
    ),
    "surface.floating.bg": source.bg.floating,
    "surface.floating.fg": source.fg.primary,
    "surface.floating.border": source.border,
    "surface.floating.scrim": "rgba(0, 0, 0, 0.5)",

    "state.hover.bg": o(0.04),
    "state.active.bg": o(0.1),
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

    "scrollbar.thumb.bg": o(0.18),
    "scrollbar.thumb.hover.bg": o(0.28),
    "scrollbar.track.bg": "transparent",

    "feedback.success.fg": source.success,
    "feedback.success.border": source.success,
    "feedback.success.bg": o(0.06),
    "feedback.info.fg": source.info,
    "feedback.info.border": source.info,
    "feedback.info.bg": o(0.06),

    "editor.text.default": source.fg.primary,
    "editor.text.muted": source.fg.muted,
    "editor.gutter.bg": source.bg.primary,
    "editor.gutter.fg": source.fg.muted,
    "editor.line.highlight": source.lineHighlight,
    "editor.selection.bg": source.selection,
    "editor.cursor.color": source.cursor,
    "editor.find.highlight": source.findHighlight,
    "editor.indent.guide": source.indentGuide,

    "sidebar.bg": source.bg.secondary,
    "sidebar.fg": source.fg.primary,
    "sidebar.item.hover.bg": o(0.04),
    "sidebar.item.selected.bg": tintedAccent(source.accent, source.bg.secondary, 0.2),
    "sidebar.item.selected.fg": source.fg.primary,
    "sidebar.item.focus.border": withAlpha(source.fg.primary, 0.6),
    "sidebar.icon.fg": source.fg.muted,
    "sidebar.badge.bg": source.accent,
    "sidebar.badge.fg": pickContrastFg(source.accent, source.bg.primary),

    "tab.bar.bg": source.bg.secondary,
    "tab.active.bg": o(0.08),
    "tab.active.fg": source.fg.primary,
    "tab.active.border": source.accent,
    "tab.inactive.bg": source.bg.secondary,
    "tab.inactive.fg": source.fg.muted,
    "tab.hover.bg": o(0.04),
    "tab.modified.dot": source.accent,
    "tab.claude.running.fg": source.accent,
    "tab.claude.attention.fg": source.claudeAttentionFg ?? source.info,
    "tab.attention.indicator": source.claudeAttentionFg ?? source.info,

    "panel.bg": source.bg.primary,
    "panel.fg": source.fg.primary,
    "panel.header.bg": source.bg.secondary,
    "panel.header.fg": source.fg.muted,
    "panel.tab.active.fg": source.fg.primary,
    "panel.tab.inactive.fg": source.fg.muted,
    "panel.border": source.border,

    "terminal.bg": source.bg.primary,
    "terminal.fg": source.fg.primary,
    "terminal.cursor.color": source.cursor,
    "terminal.cursor.accent": source.bg.primary,
    "terminal.selection.bg": source.selection,

    "diff.added.bg": o(0.06),
    "diff.added.fg": source.success,
    "diff.added.gutter": o(0.1),
    "diff.deleted.bg": o(0.06),
    "diff.deleted.fg": source.error,
    "diff.deleted.gutter": o(0.1),
    "diff.modified.bg": o(0.04),
    "diff.unchanged.fg": source.fg.muted,

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
    "git.status.untracked.fg": source.success,
    "git.status.conflict.fg": source.error,
    "git.status.renamed.fg": source.fg.muted,
    "git.status.ignored.fg": source.fg.muted,

    "status.bar.bg": source.bg.secondary,
    "status.bar.fg": source.fg.primary,
    "status.bar.item.hover.bg": o(0.1),
    "status.bar.error.bg": source.error,
    "status.bar.error.fg": source.base === "light" ? "#ffffff" : source.bg.primary,
    "status.bar.warning.bg": source.warning,
    "status.bar.warning.fg": source.bg.primary,
    "status.bar.added.fg": source.success,
    "status.bar.modified.fg": source.warning,
    "status.bar.untracked.fg": source.success,
    "status.bar.conflict.fg": source.error,

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

export function buildEditorPalette(source: ThemeSource): EditorPalette {
  const tier = (alpha: number): string => toHex8(overlay(source.base, alpha));

  return {
    wordHighlightBackground: tier(0.06),
    wordHighlightStrongBackground: tier(0.12),
    wordHighlightTextBackground: tier(0.04),
    findRangeHighlightBackground: toHex8(source.findHighlight),
    findMatchHighlightBackground: tier(0.1),
    findMatchBackground: toHex8(source.findHighlight, 0.45),
    peekViewBorder: toHex8(source.border, 0.8),
    peekViewEditorMatchHighlightBackground: tier(0.2),
    peekViewResultMatchHighlightBackground: tier(0.12),
    peekViewResultBackground: toHex8(source.bg.secondary),
    linkActiveForeground: toHex8(source.fg.primary),
    selectionBackground: toHex8(source.selection),
    inactiveSelectionBackground: scaleAlpha(source.selection, 0.5),
    selectionHighlightBackground: tier(0.06),
    hoverWidgetBackground: toHex8(source.bg.floating),
    hoverWidgetBorder: toHex8(source.border, 0.5),
    editorWidgetBackground: toHex8(source.bg.floating),
    editorWidgetBorder: toHex8(source.border, 0.8),
    errorForeground: toHex8(source.error),
    warningForeground: toHex8(source.warning, 0.85),
    infoForeground: toHex8(source.info),
    hintForeground: toHex8(source.fg.muted, 0.65),
    errorBackground: toHex8(source.error, 0.08),
    warningBackground: toHex8(source.warning, 0.06),
    infoBackground: "#00000000",
    hintBackground: "#00000000",
    editorBackground: "#00000000",
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
