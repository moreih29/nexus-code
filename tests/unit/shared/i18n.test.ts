import { describe, expect, test } from "bun:test";
import { I18N_NAMESPACES, resources } from "../../../src/shared/i18n/index";
import { THEME_SOURCES } from "../../../src/shared/design-tokens/theme-sources";

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

  test("every theme has a description in en and ko", () => {
    const ids = THEME_SOURCES.map((source) => source.id).sort();
    expect(Object.keys(resources.en.settings.appearance.themeDescription).sort()).toEqual(ids);
    expect(Object.keys(resources.ko.settings.appearance.themeDescription).sort()).toEqual(ids);
  });
});
