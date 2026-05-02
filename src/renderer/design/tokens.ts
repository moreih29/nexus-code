import { borderRadius, color, fontFamily, spacing, typeScale } from "../../shared/design-tokens";

// ---------------------------------------------------------------------------
// CSS variable name mapping
// ---------------------------------------------------------------------------

function camelToKebab(s: string): string {
  return s.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}

function buildCssVars(): string {
  const lines: string[] = [":root {"];

  // Colors
  for (const [key, value] of Object.entries(color)) {
    lines.push(`  --color-${camelToKebab(key)}: ${value};`);
  }

  // Font families
  for (const [key, value] of Object.entries(fontFamily)) {
    lines.push(`  --font-family-${camelToKebab(key)}: ${value};`);
  }

  // Type scale — expose fontSize and lineHeight only (most useful in CSS)
  for (const [role, def] of Object.entries(typeScale)) {
    const kebab = camelToKebab(role);
    lines.push(`  --type-${kebab}-size: ${def.fontSize}px;`);
    lines.push(`  --type-${kebab}-line-height: ${def.lineHeight};`);
    lines.push(`  --type-${kebab}-letter-spacing: ${def.letterSpacing}px;`);
  }

  // Spacing — indexed variables
  for (const value of spacing) {
    lines.push(`  --space-${value}: ${value}px;`);
  }

  // Border radius
  for (const [key, value] of Object.entries(borderRadius)) {
    lines.push(`  --radius-${camelToKebab(key)}: ${value}px;`);
  }

  lines.push("}");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// injectTokens — call once at app startup to inject CSS variables into :root
// ---------------------------------------------------------------------------

let injected = false;

export function injectTokens(): void {
  if (injected) return;
  injected = true;

  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-nexus-tokens", "1");
  styleEl.textContent = buildCssVars();
  document.head.appendChild(styleEl);
}
