import { describe, expect, test } from "bun:test";
import { BEHAVIOR_FIELDS } from "../../../src/shared/agent-profiles/behavior";
import { resources } from "../../../src/shared/i18n/index";

/** The words the behavior fold asks for by a key it builds (fields.${id}.label, options.${id}.${value}, ...). */
const LOCALES = ["en", "ko"] as const;

function text(locale: (typeof LOCALES)[number], ...path: string[]): unknown {
  let node: unknown = resources[locale].settings.profiles.behavior;
  for (const part of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

describe("the behavior fold's words", () => {
  for (const locale of LOCALES) {
    test(`${locale}: every field has a name, and a placeholder if it is typed`, () => {
      for (const field of BEHAVIOR_FIELDS) {
        expect({ id: field.id, label: typeof text(locale, "fields", field.id, "label") }).toEqual({
          id: field.id,
          label: "string",
        });
        if (field.kind === "text" || field.kind === "int")
          expect(typeof text(locale, "fields", field.id, "placeholder")).toBe("string");
      }
    });

    test(`${locale}: every option of a choice, and its default, has a name`, () => {
      for (const field of BEHAVIOR_FIELDS.filter((f) => f.kind === "choice")) {
        // The model and the output styles are shown as they are named, bar "default".
        if (field.id === "model") continue;
        const values = field.id === "outputStyle" ? ["default"] : (field.options ?? []);
        for (const value of [...values, ...(field.fallback ? [String(field.fallback)] : [])]) {
          expect({
            id: field.id,
            value,
            label: typeof text(locale, "options", field.id, value),
          }).toEqual({ id: field.id, value, label: "string" });
        }
      }
    });

    test(`${locale}: both agents have their notes, and no word is empty`, () => {
      for (const agent of ["claude", "codex"]) {
        expect(typeof text(locale, "tabNote", agent)).toBe("string");
        expect(typeof text(locale, "footer", agent)).toBe("string");
      }
      // i18next answers an empty string with the key itself.
      const empty: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (typeof node === "string") {
          if (node === "") empty.push(path);
        } else if (typeof node === "object" && node !== null)
          for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
      };
      walk(text(locale), "behavior");
      expect(empty).toEqual([]);
    });
  }
});
