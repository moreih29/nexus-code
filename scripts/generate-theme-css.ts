#!/usr/bin/env bun
// Standalone script to emit src/renderer/styles/theme.generated.css.
// Run: bun run scripts/generate-theme-css.ts
// Also called automatically by the vite-plugin-theme-tokens Vite plugin
// embedded in electron.vite.config.ts.

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

  lines.push("}");
  lines.push("");

  // :root — semantic aliases (shadcn convention)
  lines.push(":root {");
  const semantic = buildSemanticTokens();
  for (const [key, value] of Object.entries(semantic)) {
    lines.push(`  ${key}: ${value};`);
  }
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

// When run directly as a script
const outPath = resolve(import.meta.dir, "../src/renderer/styles/theme.generated.css");
writeFileSync(outPath, generateThemeCss(), "utf-8");
console.log(`[theme] Written: ${outPath}`);
