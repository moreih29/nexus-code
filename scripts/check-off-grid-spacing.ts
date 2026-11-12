#!/usr/bin/env bun
// Scans src/renderer/ for Tailwind spacing utilities that violate the 4pt grid
// defined in design.md §3.
//
// Allowed grid steps (design.md §3 table):
//   2 / 4 / 6 / 8 / 10 / 12 / 16 / 24 / 32 / 48 px
//   → *-0.5 / *-1 / *-1.5 / *-2 / *-2.5 / *-3 / *-4 / *-6 / *-8 / *-12
//   (6 = Islands gap, 10 = narrow padding in settings/sidebar — the .5 steps formally
//    adopted in design.md §3)
//
// Forbidden arbitrary px spacing values (margin/padding/gap):
//   [5px] [14px] [15px] [18px] [26px] [30px]
//   (6px and 10px are formal steps written as *-1.5 / *-2.5, so only the arbitrary form is
//    forbidden.)
//
// Run: bun run scripts/check-off-grid-spacing.ts
// Wired into package.json scripts: lint:tw (split out of the main lint)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = "src/renderer";
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "out"]);
const SKIP_FILE_SUBSTRINGS = [".generated."];

// The .5 steps in design.md §3 (1.5=6px, 2.5=10px) are formally adopted, so they are not
// forbidden.
// This guard checks only the arbitrary [Xpx] form — the *-1.5 / *-2.5 notation passes.
//
// Matches Tailwind spacing utilities with a forbidden arbitrary px value.
// Does NOT match: text-[Xpx], ring-[Xpx], border-[Xpx], size-[Xpx], w-[Xpx], h-[Xpx]
const ARBITRARY_PX_PATTERN =
  /\b(?:gap|p[xytblr]?|m[xytblr]?|space-[xy]|inset(?:-[xy])?)-\[(?:5|14|15|18|26|30)px\]/g;

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
  console.error("\nAllowed spacing steps (design.md §3):");
  console.error("  *-0.5 (2px)  *-1 (4px)  *-1.5 (6px)  *-2 (8px)  *-2.5 (10px)");
  console.error("  *-3 (12px)   *-4 (16px) *-6 (24px)   *-8 (32px) *-12 (48px)");
  console.error("\nForbidden: arbitrary [5/14/15/18/26/30px].");
  console.error("  (6px, 10px 은 *-1.5 / *-2.5 표기 사용 — arbitrary 형식만 금지)");
  process.exit(1);
}

console.log("✓ No off-grid spacing violations found in src/renderer/.");
