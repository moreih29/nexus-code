#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { appTypeScale, typeScale } from "../src/shared/design-tokens/index";

const ROOT = "src/renderer";
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "out"]);
const SKIP_FILE_SUBSTRINGS = [".generated."];

const camelToKebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const VALID_ROLE_CLASSES = new Set(
  [...Object.keys(appTypeScale), ...Object.keys(typeScale)].map(
    (role) => `text-${camelToKebab(role)}`,
  ),
);

const FORBIDDEN_MARKETING_CLASSES = new Set([
  "text-display-hero",
  "text-section-display",
  "text-section-heading",
  "text-feature-heading",
  "text-sub-heading-large",
  "text-card-display",
  "text-sub-heading",
  "text-body-heading",
  "text-card-title",
  "text-body-large",
  "text-body",
  "text-nav-ui",
  "text-button-text",
  "text-caption",
  "text-small-label",
  "text-micro",
]);

const TEXT_TOKEN_PATTERN = /\btext-[a-z][a-z0-9-]*(?=[\s"'`\]])/g;

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

    const lines = readFileSync(full, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(TEXT_TOKEN_PATTERN)) {
        const token = m[0];
        if (token.startsWith("text-app-") || token.startsWith("text-code-")) {
          if (!VALID_ROLE_CLASSES.has(token)) {
            violations.push({
              file: full,
              line: i + 1,
              match: token,
              rule: "undefined type role — not in appTypeScale / typeScale",
            });
          }
        } else if (FORBIDDEN_MARKETING_CLASSES.has(token)) {
          violations.push({
            file: full,
            line: i + 1,
            match: token,
            rule: "marketing typescale role — prohibited in-app (design.md §5), not emitted",
          });
        }
      }
    }
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error(
    `✗ Undefined typography utilities detected — violates design.md §5 closed role set (${violations.length} violation${violations.length === 1 ? "" : "s"}):\n`,
  );
  for (const v of violations) {
    console.error(`  ${relative(".", v.file)}:${v.line}  ${v.match}  [${v.rule}]`);
  }
  console.error("\nValid in-app typography utilities (design.md §5):");
  console.error(`  ${[...VALID_ROLE_CLASSES].sort().join("  ")}`);
  console.error("\nA new size must be added as a role in src/shared/design-tokens/index.ts");
  console.error("(appTypeScale) — never use an ad-hoc text-* class or text-[Npx].");
  process.exit(1);
}

console.log("✓ No undefined typography utilities found in src/renderer/.");
