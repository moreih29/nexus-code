import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ThemeId } from "../src/shared/design-tokens";
import {
  appTypeScale,
  borderRadius,
  buildShadcnVars,
  color,
  fontFamily,
  islandGeometry,
  spacing,
} from "../src/shared/design-tokens";
import { DEFAULT_THEME, THEMES } from "../src/shared/design-tokens/themes";
import { EDITOR_PALETTES } from "../src/shared/editor/palette";

function camelToKebab(s: string): string {
  return s.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}

const SEMANTIC_COLOR_KEYS = new Set([
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--floating-scrim",
  "--state-hover-bg",
  "--state-active-bg",
  "--state-loading-indicator",
  "--tab-active-bg",
  "--tab-active-border",
  "--tab-hover-bg",
]);

const SEMANTIC_SHADOW_KEYS = new Set([
  "--shadow",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--shadow-xl",
  "--shadow-2xl",
]);

function gitTokensForTheme(themeId: ThemeId): Record<string, string> {
  const theme = THEMES[themeId];
  const isDark = themeId !== "warm-light";
  const lanes: Record<string, string> = {};
  for (let i = 0; i <= 7; i++) {
    const key = `git.lane.${i}` as keyof typeof theme;
    lanes[`--color-git-lane-${i}`] = theme[key];
  }
  return {
    ...lanes,
    "--color-git-chip-head-bg": theme["git.label.branch.bg"],
    "--color-git-chip-head-fg": theme["git.label.branch.fg"],
    "--color-git-chip-border": theme["surface.island.border"],
    "--color-git-chip-border-strong": theme["surface.floating.border"],
    "--color-git-chip-hover-bg": theme["state.hover.bg"],
    "--color-status-banner-fg": theme["surface.island.fg"],
    "--color-workspace-connection-idle": isDark ? "oklch(0.68 0.003 84)" : "oklch(0.48 0.003 84)",
    "--color-workspace-connection-connected": theme["feedback.success.fg"],
    "--color-workspace-connection-connecting": theme["state.warning.fg"],
    "--color-workspace-connection-error": theme["state.error.fg"],
  };
}

function syntaxTokensForTheme(themeId: ThemeId): Record<string, string> {
  const palette = EDITOR_PALETTES[themeId];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(palette)) {
    if (key.startsWith("syntax")) out[`--${camelToKebab(key)}`] = value;
  }
  return out;
}

function emitDensityOverrideBlock(): string[] {
  const lines: string[] = [];
  lines.push("/* density=compact overrides — higher specificity than :root and [data-theme]. */");
  lines.push("/* Emitted after :root for readability; cascade wins by specificity, not order. */");
  lines.push(":root[data-density='compact'] {");
  lines.push(`  --radius-island: ${islandGeometry.radiusCompact}px;`);
  lines.push(`  --island-gap: ${islandGeometry.gapCompact}px;`);
  lines.push("}");
  return lines;
}

export function generateThemeCss(): string {
  const lines: string[] = [];

  lines.push("@theme inline {");

  for (const [key, value] of Object.entries(color)) {
    lines.push(`  --color-${camelToKebab(key)}: ${value};`);
  }

  const TAILWIND_FONT_KEYS = new Set(["sans", "mono"]);
  for (const [key, value] of Object.entries(fontFamily)) {
    const varName = TAILWIND_FONT_KEYS.has(key)
      ? `--font-${camelToKebab(key)}`
      : `--font-family-${camelToKebab(key)}`;
    lines.push(`  ${varName}: ${value};`);
  }

  const codeTypeScaleEntries = [
    ["codeUi", { fontSize: 16, lineHeight: 1.0, letterSpacing: 0, fontWeight: 400 }],
    ["codeBody", { fontSize: 16, lineHeight: 1.0, letterSpacing: -0.2, fontWeight: 400 }],
  ] as const;
  const allTypeScaleEntries = [...codeTypeScaleEntries, ...Object.entries(appTypeScale)];
  for (const [role, def] of allTypeScaleEntries) {
    const kebab = camelToKebab(role);
    lines.push(`  --text-${kebab}: ${def.fontSize}px;`);
    lines.push(`  --text-${kebab}--line-height: ${def.lineHeight};`);
    lines.push(`  --text-${kebab}--letter-spacing: ${def.letterSpacing}px;`);
    lines.push(`  --text-${kebab}--font-weight: ${def.fontWeight};`);
  }

  for (const value of spacing) {
    lines.push(`  --space-${value}: ${value}px;`);
  }

  for (const [key, value] of Object.entries(borderRadius)) {
    lines.push(`  --radius-${camelToKebab(key)}: ${value}px;`);
  }

  lines.push("");
  lines.push("  /* shadcn semantic aliases — var() references enable [data-theme] cascade */");
  for (const key of SEMANTIC_COLOR_KEYS) {
    lines.push(`  --color-${key.slice(2)}: var(${key});`);
  }

  const defaultSemantic = buildShadcnVars(THEMES[DEFAULT_THEME]);
  for (const key of SEMANTIC_SHADOW_KEYS) {
    const value = defaultSemantic[key];
    if (value !== undefined) {
      lines.push(`  ${key}: ${value};`);
    }
  }

  lines.push("}");
  lines.push("");

  lines.push(":root {");
  for (const [key, value] of Object.entries(defaultSemantic)) {
    lines.push(`  ${key}: ${value};`);
  }
  for (const [key, value] of Object.entries(gitTokensForTheme(DEFAULT_THEME))) {
    lines.push(`  ${key}: ${value};`);
  }
  for (const [key, value] of Object.entries(syntaxTokensForTheme(DEFAULT_THEME))) {
    lines.push(`  ${key}: ${value};`);
  }
  lines.push("}");
  lines.push("");

  lines.push(...emitDensityOverrideBlock());
  lines.push("");

  for (const themeId of Object.keys(THEMES) as ThemeId[]) {
    const semantic = buildShadcnVars(THEMES[themeId]);
    lines.push(`[data-theme="${themeId}"] {`);
    for (const [key, value] of Object.entries(semantic)) {
      lines.push(`  ${key}: ${value};`);
    }
    for (const [key, value] of Object.entries(gitTokensForTheme(themeId))) {
      lines.push(`  ${key}: ${value};`);
    }
    for (const [key, value] of Object.entries(syntaxTokensForTheme(themeId))) {
      lines.push(`  ${key}: ${value};`);
    }
    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

export function writeThemeCss(): void {
  const outPath = resolve(import.meta.dir, "../src/renderer/styles/theme.generated.css");
  writeFileSync(outPath, generateThemeCss(), "utf-8");
  console.log(`[theme] Written: ${outPath}`);
}

if (import.meta.main) {
  writeThemeCss();
}
