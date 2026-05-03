#!/usr/bin/env bun
// Scans src/ for Tailwind v3.3-style `[--my-var]` shorthand (square brackets
// without `var()`). Tailwind v4 dropped this shorthand and the offending
// classes silently produce no CSS rule, so the visual effect is missing
// without any compile-time warning.
//
// This script fails the build with a list of offenders. Use one of these
// canonical Tailwind v4 forms instead:
//
//   bg-X            -- auto-utility generated from a @theme token
//   bg-(--X)        -- Tailwind v4 CSS-variable shortcut
//   bg-[var(--X)]   -- explicit var() reference
//
// Run: bun run scripts/check-tailwind-syntax.ts
// Wired into package.json scripts: lint, check:ci

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = "src";
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "out"]);
const SKIP_FILE_SUBSTRINGS = [".generated."];

// Matches a Tailwind utility followed by an arbitrary value that starts with
// `--` (e.g. `bg-[--color-foo]`, `text-[--muted-foreground]`,
// `border-l-[--color-mist-border]`). Does NOT match `bg-[var(--foo)]` or
// `bg-(--foo)`, which are the canonical forms.
const PATTERN = /[\w-]+-\[--[\w-]+\]/g;

interface Violation {
  file: string;
  line: number;
  match: string;
}

const violations: Violation[] = [];

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIR_NAMES.has(entry)) walk(full);
      continue;
    }
    if (!SCAN_EXTENSIONS.has(extname(entry))) continue;
    if (SKIP_FILE_SUBSTRINGS.some((s) => entry.includes(s))) continue;

    const content = readFileSync(full, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const m of line.matchAll(PATTERN)) {
        violations.push({ file: full, line: i + 1, match: m[0] });
      }
    }
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error(`✗ Tailwind v3-style bracket-CSS-var classes detected (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  ${relative(".", v.file)}:${v.line}  ${v.match}`);
  }
  console.error("\nTailwind v4 dropped the `[--my-var]` shorthand; these classes silently");
  console.error("produce no CSS rule. Use one of:");
  console.error("  bg-X            (auto-utility generated from @theme tokens)");
  console.error("  bg-(--X)        (Tailwind v4 CSS-variable shortcut)");
  console.error("  bg-[var(--X)]   (explicit var() reference)");
  process.exit(1);
}

console.log("✓ No Tailwind v3-style bracket-CSS-var classes found.");
