#!/usr/bin/env bun
// Scans src/renderer/ for Tailwind spacing utilities that violate the 4pt grid
// defined in design.md §3 (space-1..space-8: 2/4/8/12/16/24/32/48px).
//
// Forbidden Tailwind spacing steps:
//   *-1.5  → 6px  (between space-1=2px and space-3=8px)
//   *-2.5  → 10px (between space-3=8px and space-4=12px)
//
// Forbidden arbitrary px spacing values (margin/padding/gap):
//   [5px] [6px] [10px] [14px] [15px] [18px] [26px] [30px]
//
// Use one of the 4pt grid steps instead:
//   *-0.5 (2px) | *-1 (4px) | *-2 (8px) | *-3 (12px) | *-4 (16px)
//   | *-6 (24px) | *-8 (32px) | *-12 (48px)
//
// Run: bun run scripts/check-off-grid-spacing.ts
// Wired into package.json scripts: lint, check:ci via lint:tw

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = "src/renderer";
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "out"]);
const SKIP_FILE_SUBSTRINGS = [".generated."];

// Matches Tailwind spacing utilities with a forbidden .5 step (1.5=6px or 2.5=10px).
// Covered prefixes: gap, px, py, pt, pb, pl, pr, p, mx, my, mt, mb, ml, mr, m,
//                   space-x, space-y, inset-x, inset-y, inset
// Lookahead ensures we match only at end-of-token (whitespace, quote, bracket, backtick).
const HALF_STEP_PATTERN =
  /\b(?:gap|p[xytblr]?|m[xytblr]?|space-[xy]|inset(?:-[xy])?)-(?:1\.5|2\.5)(?=[\s"'\]`])/g;

// Matches Tailwind spacing utilities with a forbidden arbitrary px value.
// Does NOT match: text-[Xpx], ring-[Xpx], border-[Xpx], size-[Xpx], w-[Xpx], h-[Xpx]
const ARBITRARY_PX_PATTERN =
  /\b(?:gap|p[xytblr]?|m[xytblr]?|space-[xy]|inset(?:-[xy])?)-\[(?:5|6|10|14|15|18|26|30)px\]/g;

interface Violation {
  file: string;
  line: number;
  match: string;
  rule: string;
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
      for (const m of line.matchAll(HALF_STEP_PATTERN)) {
        violations.push({
          file: full,
          line: i + 1,
          match: m[0],
          rule: "off-grid .5-step (6px or 10px)",
        });
      }
      for (const m of line.matchAll(ARBITRARY_PX_PATTERN)) {
        violations.push({
          file: full,
          line: i + 1,
          match: m[0],
          rule: "off-grid arbitrary px value",
        });
      }
    }
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error(
    `✗ Off-grid spacing detected — violates design.md §3 4pt grid (${violations.length} violation${violations.length === 1 ? "" : "s"}):\n`,
  );
  for (const v of violations) {
    console.error(`  ${relative(".", v.file)}:${v.line}  ${v.match}  [${v.rule}]`);
  }
  console.error("\nAllowed spacing steps (4pt grid, design.md §3):");
  console.error("  *-0.5 (2px)  *-1 (4px)  *-2 (8px)  *-3 (12px)  *-4 (16px)");
  console.error("  *-6 (24px)   *-8 (32px)  *-12 (48px)");
  console.error("\nForbidden: *-1.5 (6px), *-2.5 (10px), and arbitrary [5/6/10/14/15/18/26/30px].");
  process.exit(1);
}

console.log("✓ No off-grid spacing violations found in src/renderer/.");
