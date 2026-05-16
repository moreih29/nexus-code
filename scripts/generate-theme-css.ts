// Standalone script to emit src/renderer/styles/theme.generated.css.
// Run: bun run scripts/generate-theme-css.ts
// Also imported by the vite-plugin-theme-tokens Vite plugin in
// electron.vite.config.ts — keep this file shebang-free so esbuild can
// require() it without a parse error on the leading "#!".
//
// Architecture (plan.json Issue 3 decision (2)):
//   @theme inline — declares --color-* as var(--<shadcn-name>) references.
//     Tailwind v4 generates bg-*, text-*, border-* utilities from these.
//     Because the values are var() references, the utilities automatically
//     pick up whichever [data-theme] scope is active on <html>.
//   [data-theme="<id>"] — sets the raw --<shadcn-name> values for each theme.
//   :root — sets default (warm-dark) values as fallback when no data-theme is present.
//
// Researcher verification: Tailwind v4 @theme inline with var() references
// allows cascade-aware theme switching via [data-theme] attribute.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appTypeScale,
  borderRadius,
  buildShadcnVars,
  color,
  fontFamily,
  spacing,
} from "../src/shared/design-tokens";
import { DEFAULT_THEME, THEMES } from "../src/shared/design-tokens/themes";
import type { ThemeId } from "../src/shared/design-tokens";

function camelToKebab(s: string): string {
  return s.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// shadcn color property names (bare var names without --)
// These are the CSS custom properties set inside [data-theme] blocks.
// The @theme inline block references them as var(--<name>).
// ---------------------------------------------------------------------------

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
  // Floating surface scrim — modal backdrop for L3 dialogs/command palette
  "--floating-scrim",
  // State overlays — emitted as --color-state-* for Tailwind arbitrary-value use
  "--state-hover-bg",
  "--state-active-bg",
  "--state-loading-indicator",
  // Tab surface tokens — emitted for semantic tab-bar theming
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

// ---------------------------------------------------------------------------
// Git chip + workspace connection per-theme tokens.
// Previously hardcoded in globals.css manual [data-theme] blocks.
// Now derived from the theme's semantic tokens so they stay in sync.
// ---------------------------------------------------------------------------

function gitTokensForTheme(themeId: ThemeId): Record<string, string> {
  const theme = THEMES[themeId];
  const isDark = themeId !== "warm-light";
  // git lane colors: emitted as --color-git-lane-{n} for graph canvas reads
  const lanes: Record<string, string> = {};
  for (let i = 0; i <= 7; i++) {
    const key = `git.lane.${i}` as keyof typeof theme;
    lanes[`--color-git-lane-${i}`] = theme[key];
  }
  return {
    ...lanes,
    "--color-git-chip-head-bg": theme["git.label.branch.bg"],
    "--color-git-chip-head-fg": theme["git.label.branch.fg"],
    "--color-git-chip-border": theme["surface.panel.border"],
    "--color-git-chip-border-strong": theme["surface.floating.border"],
    "--color-git-chip-hover-bg": theme["state.hover.bg"],
    "--color-status-banner-fg": theme["surface.canvas.fg"],
    // workspace connection status colors (semantic: success/warning/error/disabled)
    "--color-workspace-connection-idle": isDark
      ? "oklch(0.68 0.003 84)"
      : "oklch(0.48 0.003 84)",
    "--color-workspace-connection-connected": theme["feedback.success.fg"],
    "--color-workspace-connection-connecting": theme["state.warning.fg"],
    "--color-workspace-connection-error": theme["state.error.fg"],
  };
}

export function generateThemeCss(): string {
  const lines: string[] = [];

  // ---------------------------------------------------------------------------
  // @theme inline — Tailwind v4 design-system tokens.
  //
  // Color tokens use var(--<shadcn-name>) references so Tailwind utilities
  // (bg-background, text-foreground, border-border, etc.) cascade through
  // the active [data-theme] scope on <html data-theme="*">.
  //
  // Non-color tokens (fonts, type scale, spacing, radius) are static —
  // they don't need cascade and are emitted as literal values.
  // ---------------------------------------------------------------------------
  lines.push("@theme inline {");

  // Raw color palette (static — not theme-switched, used for direct references)
  for (const [key, value] of Object.entries(color)) {
    lines.push(`  --color-${camelToKebab(key)}: ${value};`);
  }

  // Font families (static)
  const TAILWIND_FONT_KEYS = new Set(["sans", "mono"]);
  for (const [key, value] of Object.entries(fontFamily)) {
    const varName = TAILWIND_FONT_KEYS.has(key)
      ? `--font-${camelToKebab(key)}`
      : `--font-family-${camelToKebab(key)}`;
    lines.push(`  ${varName}: ${value};`);
  }

  // Type scale (static — same across themes)
  // Emission order: code (Monaco/xterm) → app UI
  // Marketing 18-role type scale is NOT emitted here (design.md §5 prohibition).
  const codeTypeScaleEntries = [
    ["codeUi", { fontSize: 16, lineHeight: 1.0, letterSpacing: 0, fontWeight: 400 }],
    ["codeBody", { fontSize: 16, lineHeight: 1.0, letterSpacing: -0.2, fontWeight: 400 }],
  ] as const;
  const allTypeScaleEntries = [
    ...codeTypeScaleEntries,
    ...Object.entries(appTypeScale),
  ];
  for (const [role, def] of allTypeScaleEntries) {
    const kebab = camelToKebab(role);
    lines.push(`  --text-${kebab}: ${def.fontSize}px;`);
    lines.push(`  --text-${kebab}--line-height: ${def.lineHeight};`);
    lines.push(`  --text-${kebab}--letter-spacing: ${def.letterSpacing}px;`);
    lines.push(`  --text-${kebab}--font-weight: ${def.fontWeight};`);
  }

  // Spacing (static)
  for (const value of spacing) {
    lines.push(`  --space-${value}: ${value}px;`);
  }

  // Border radius (static)
  for (const [key, value] of Object.entries(borderRadius)) {
    lines.push(`  --radius-${camelToKebab(key)}: ${value}px;`);
  }

  // ---------------------------------------------------------------------------
  // shadcn semantic color aliases — var() references into the active [data-theme].
  // This is the key change for @theme inline cascade:
  //   --color-background: var(--background)
  //   --color-foreground: var(--foreground)  etc.
  // Tailwind utilities (bg-background, text-foreground) now respond to
  // [data-theme] attribute changes without a page reload.
  // ---------------------------------------------------------------------------
  lines.push("");
  lines.push("  /* shadcn semantic aliases — var() references enable [data-theme] cascade */");
  for (const key of SEMANTIC_COLOR_KEYS) {
    // --background → --color-background: var(--background)
    lines.push(`  --color-${key.slice(2)}: var(${key});`);
  }

  // Shadow aliases — SEALED to "none"; emit verbatim (not var() refs, invariant)
  const defaultSemantic = buildShadcnVars(THEMES[DEFAULT_THEME]);
  for (const key of SEMANTIC_SHADOW_KEYS) {
    const value = defaultSemantic[key];
    if (value !== undefined) {
      lines.push(`  ${key}: ${value};`);
    }
  }

  lines.push("}");
  lines.push("");

  // ---------------------------------------------------------------------------
  // :root — sets default theme (warm-dark) CSS var values.
  // Applies when no [data-theme] attribute is set (e.g. during SSR/initial load
  // before the boot script runs, or when preference is not yet known).
  // ---------------------------------------------------------------------------
  lines.push(":root {");
  for (const [key, value] of Object.entries(defaultSemantic)) {
    lines.push(`  ${key}: ${value};`);
  }
  // Default git/workspace tokens
  for (const [key, value] of Object.entries(gitTokensForTheme(DEFAULT_THEME))) {
    lines.push(`  ${key}: ${value};`);
  }
  lines.push("}");
  lines.push("");

  // ---------------------------------------------------------------------------
  // [data-theme="<id>"] scoped blocks — one per registered theme.
  // Sets the raw CSS var values that the @theme inline var() references resolve to.
  // Runtime switching: document.documentElement.setAttribute("data-theme", id)
  // ---------------------------------------------------------------------------
  for (const themeId of Object.keys(THEMES) as ThemeId[]) {
    const semantic = buildShadcnVars(THEMES[themeId]);
    lines.push(`[data-theme="${themeId}"] {`);
    for (const [key, value] of Object.entries(semantic)) {
      lines.push(`  ${key}: ${value};`);
    }
    // Git chip + workspace connection tokens (absorbed from globals.css)
    for (const [key, value] of Object.entries(gitTokensForTheme(themeId))) {
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

// Run only when invoked as a CLI (`bun run scripts/generate-theme-css.ts`).
// When imported by vite-plugin-theme-tokens this guard prevents a duplicate
// write at module-load time.
if (import.meta.main) {
  writeThemeCss();
}
