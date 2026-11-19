import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { THEME_SOURCES } from "../../../src/shared/design-tokens/theme-sources";
import { I18N_NAMESPACES, resources } from "../../../src/shared/i18n/index";

/** Dotted path of every leaf in a locale namespace, sorted. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value)
    .flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

// ---------------------------------------------------------------------------
// Resources structure
// ---------------------------------------------------------------------------

describe("resources", () => {
  // Only en is type-checked (i18next.d.ts derives the t() keys from it), so a
  // key missing from or misspelt in a ko JSON file shows up only here.
  test("en and ko define the same key paths in every namespace", () => {
    for (const ns of I18N_NAMESPACES) {
      const en = keyPaths(resources.en[ns]);
      const ko = keyPaths(resources.ko[ns]);
      expect({
        ns,
        missingInKo: en.filter((key) => !ko.includes(key)),
        extraInKo: ko.filter((key) => !en.includes(key)),
      }).toEqual({ ns, missingInKo: [], extraInKo: [] });
    }
  });

  // The panels look a server's status up by what Codex reports, which the
  // /mcp card already has words for: a status without one shows in English.
  test("the MCP panel words every status the /mcp card does, in en and ko", () => {
    for (const locale of ["en", "ko"] as const) {
      const { chat } = resources[locale].common;
      const panel = Object.keys(chat.panel.mcp.status);
      const card = Object.keys(chat.codex.commands.mcp_status);
      expect({ locale, missing: card.filter((status) => !panel.includes(status)) }).toEqual({
        locale,
        missing: [],
      });
    }
  });

  test("every theme has a description in en and ko", () => {
    const ids = THEME_SOURCES.map((source) => source.id).sort();
    expect(Object.keys(resources.en.settings.appearance.themeDescription).sort()).toEqual(ids);
    expect(Object.keys(resources.ko.settings.appearance.themeDescription).sort()).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------
// Keys the code asks for
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "../../..");

/** Whether `key` (dotted, maybe with a plural suffix left off) is a string in `tree`. */
function defines(tree: unknown, key: string): boolean {
  const parts = key.split(".");
  const last = parts.pop() ?? "";
  let node: unknown = tree;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "object" || node === null) return false;
  const leaves = node as Record<string, unknown>;
  return [last, `${last}_one`, `${last}_other`].some((name) => typeof leaves[name] === "string");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

describe("keys in the code", () => {
  // The t() key types in i18next.d.ts do not reach the renderer's tsconfig
  // project, so a key renamed in the code and not in the JSON (or the other
  // way round) type-checks, and the app shows the raw key. This reads the
  // literal keys the code passes to t() and looks each up in the en files.
  test("every literal key passed to t() is in an en namespace", () => {
    const en = resources.en as Record<string, unknown>;
    const missing: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      // A file's own t that puts a prefix before the key, as
      // `const t = (key: string) => i18next.t(\`notes:recorder.${key}\`)`.
      const helper = source.match(/const t = \([^)]*\)\s*=>\s*i18next\.t\(`([^`$]*)\$\{key\}`/);
      const prefix = helper?.[1] ?? "";
      for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_.:-]+)"/g)) {
        const key = `${prefix}${match[1]}`;
        const [ns, path] = key.includes(":") ? key.split(":", 2) : [undefined, key];
        const found = ns
          ? defines(en[ns], path ?? "")
          : Object.values(en).some((tree) => defines(tree, key));
        if (!found) {
          const line = source.slice(0, match.index).split("\n").length;
          missing.push(`${relative(ROOT, file)}:${line} ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
