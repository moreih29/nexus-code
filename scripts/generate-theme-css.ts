// Standalone script to emit src/renderer/styles/theme.generated.css.
// Run: bun run scripts/generate-theme-css.ts
// Also imported by the vite-plugin-theme-tokens Vite plugin in
// electron.vite.config.ts — keep this file shebang-free so esbuild can
// require() it without a parse error on the leading "#!".

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appTypeScale,
  borderRadius,
  buildSemanticTokens,
  color,
  fontFamily,
  spacing,
  typeScale,
} from "../src/shared/design-tokens";

function camelToKebab(s: string): string {
  return s.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}

export function generateThemeCss(): string {
  const lines: string[] = [];

  // @theme block — exposes raw tokens as Tailwind v4 design-system tokens
  lines.push("@theme {");

  // Raw color palette
  for (const [key, value] of Object.entries(color)) {
    lines.push(`  --color-${camelToKebab(key)}: ${value};`);
  }

  // Font families.
  // `sans` and `mono` are Tailwind utility keys → emit as --font-{key} so that
  // the font-sans / font-mono utilities resolve to the intended fonts.
  // All other role keys use --font-family-{key} for project-specific usage.
  const TAILWIND_FONT_KEYS = new Set(["sans", "mono"]);
  for (const [key, value] of Object.entries(fontFamily)) {
    const varName = TAILWIND_FONT_KEYS.has(key)
      ? `--font-${camelToKebab(key)}`
      : `--font-family-${camelToKebab(key)}`;
    lines.push(`  ${varName}: ${value};`);
  }

  // Type scale — Tailwind v4 --text-{role} + double-hyphen modifiers
  // Processes marketing scale (typeScale) then application-UI scale (appTypeScale).
  for (const [role, def] of [...Object.entries(typeScale), ...Object.entries(appTypeScale)]) {
    const kebab = camelToKebab(role);
    lines.push(`  --text-${kebab}: ${def.fontSize}px;`);
    lines.push(`  --text-${kebab}--line-height: ${def.lineHeight};`);
    lines.push(`  --text-${kebab}--letter-spacing: ${def.letterSpacing}px;`);
    lines.push(`  --text-${kebab}--font-weight: ${def.fontWeight};`);
  }

  // Spacing
  for (const value of spacing) {
    lines.push(`  --space-${value}: ${value}px;`);
  }

  // Border radius
  for (const [key, value] of Object.entries(borderRadius)) {
    lines.push(`  --radius-${camelToKebab(key)}: ${value}px;`);
  }

  // ---------------------------------------------------------------------------
  // shadcn semantic aliases — emitted *inside* @theme so Tailwind v4 generates
  // matching utilities (bg-popover, shadow-sm, etc). The same values are also
  // emitted in :root below as the bare shadcn names (--popover, --shadow-sm)
  // so ad-hoc CSS and arbitrary-value classes (bg-[var(--popover)]) keep
  // working for both naming conventions.
  // ---------------------------------------------------------------------------
  const semantic = buildSemanticTokens();

  // Color aliases → --color-{name} so bg-{name} / text-{name} / border-{name}
  // / ring-{name} utilities resolve.
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
  ]);

  // Shadow aliases — already in the --shadow-* namespace; emit verbatim so
  // shadow / shadow-sm / shadow-md / ... utilities pick them up (and stay
  // sealed to "none" per project policy).
  const SEMANTIC_SHADOW_KEYS = new Set([
    "--shadow",
    "--shadow-sm",
    "--shadow-md",
    "--shadow-lg",
    "--shadow-xl",
    "--shadow-2xl",
  ]);

  lines.push("");
  lines.push("  /* shadcn semantic aliases — Tailwind v4 utility namespace */");
  for (const [key, value] of Object.entries(semantic)) {
    if (SEMANTIC_COLOR_KEYS.has(key)) {
      // --popover → --color-popover, --popover-foreground → --color-popover-foreground
      lines.push(`  --color-${key.slice(2)}: ${value};`);
    } else if (SEMANTIC_SHADOW_KEYS.has(key)) {
      lines.push(`  ${key}: ${value};`);
    }
  }

  lines.push("}");
  lines.push("");

  // :root — semantic aliases under their bare shadcn names (--popover, etc.)
  // so direct CSS-var consumers and arbitrary-value classes still resolve.
  lines.push(":root {");
  for (const [key, value] of Object.entries(semantic)) {
    lines.push(`  ${key}: ${value};`);
  }
  lines.push("}");
  lines.push("");

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
