import { describe, expect, it } from "bun:test";
import {
  countValues,
  JsonSyntaxError,
  type JsonValue,
  parseJson,
} from "../../../../../../src/renderer/services/editor/preview/json-tree";

/** The plain value `value` stands for, numbers as numbers. */
function plain(value: JsonValue): unknown {
  switch (value.kind) {
    case "object":
      return Object.fromEntries(value.entries.map((entry) => [entry.key, plain(entry.value)]));
    case "array":
      return value.items.map(plain);
    case "number":
      return Number(value.text);
    case "null":
      return null;
    default:
      return value.value;
  }
}

function syntaxError(text: string): JsonSyntaxError {
  try {
    parseJson(text);
  } catch (error) {
    if (error instanceof JsonSyntaxError) return error;
    throw error;
  }
  throw new Error(`parsed: ${text}`);
}

describe("parseJson", () => {
  it("reads what JSON.parse reads", () => {
    const text = JSON.stringify({
      a: [1, -2.5, 3e10, true, false, null, "x"],
      b: { c: '" \\ / \b \f \n \r \t é 😀' },
      "": [],
      d: {},
    });
    expect(plain(parseJson(text))).toEqual(JSON.parse(text));
  });

  it("reads escapes, a BOM and a lone value", () => {
    expect(plain(parseJson('"\\u00e9\\ud83d\\ude00\\/"'))).toBe("é😀/");
    expect(plain(parseJson("﻿ 42 "))).toBe(42);
    expect(plain(parseJson("null"))).toBeNull();
  });

  it("takes comments and a comma after the last member", () => {
    const text = `{
      // compiler options
      "compilerOptions": { "strict": true, /* on */ "paths": ["a", "b",], },
    }`;
    expect(plain(parseJson(text))).toEqual({
      compilerOptions: { strict: true, paths: ["a", "b"] },
    });
  });

  it("keeps a number's text, members' order, and a key written twice", () => {
    const root = parseJson('{"b": 12345678901234567890, "a": 1.50, "b": 2}');
    expect(root).toEqual({
      kind: "object",
      entries: [
        { key: "b", value: { kind: "number", text: "12345678901234567890" } },
        { key: "a", value: { kind: "number", text: "1.50" } },
        { key: "b", value: { kind: "number", text: "2" } },
      ],
    });
  });

  it("reads a deeply nested file", () => {
    const depth = 100_000;
    const root = parseJson(`${"[".repeat(depth)}${"]".repeat(depth)}`);
    expect(countValues(root)).toBe(depth);
  });

  it("names where the text stops being JSON", () => {
    expect(syntaxError('{\n  "a": 1\n  "b": 2\n}')).toMatchObject({ line: 3, column: 3 });
    expect(syntaxError('{"a" 1}')).toMatchObject({ line: 1, column: 6 });
    expect(syntaxError("[1, 2")).toMatchObject({ line: 1, column: 6 });
    expect(syntaxError("{a: 1}")).toMatchObject({ line: 1, column: 2 });
    expect(syntaxError('"a\nb"')).toMatchObject({ line: 1, column: 3 });
    expect(syntaxError('"\\x"')).toMatchObject({ line: 1, column: 2 });
    expect(syntaxError("[1] 2")).toMatchObject({ line: 1, column: 5 });
    expect(syntaxError("/* open")).toMatchObject({ line: 1, column: 1 });
    expect(syntaxError("[01]")).toMatchObject({ line: 1, column: 3 });
    expect(syntaxError("")).toMatchObject({ line: 1, column: 1 });
  });
});
