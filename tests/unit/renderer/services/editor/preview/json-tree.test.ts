import { describe, expect, it } from "bun:test";
import { findMatches } from "../../../../../../src/renderer/services/editor/preview/find/find-matches";
import {
  ancestorPaths,
  countValues,
  JsonSyntaxError,
  type JsonValue,
  labelText,
  parseJson,
  treeMatches,
  valueText,
  visibleRows,
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

describe("visibleRows", () => {
  const root = parseJson('{"a": {"b": [1, 2]}, "c": "x", "d": []}');
  const rowsOf = (open: string[]) =>
    visibleRows(root, (path) => open.includes(path)).map((row) => [row.depth, row.label]);

  it("shows the root's members, and the members of what is open under it", () => {
    expect(rowsOf([])).toEqual([
      [0, "a"],
      [0, "c"],
      [0, "d"],
    ]);
    expect(rowsOf(["\u0000a", "\u0000a\u0000b"])).toEqual([
      [0, "a"],
      [1, "b"],
      [2, 0],
      [2, 1],
      [0, "c"],
      [0, "d"],
    ]);
  });

  it("does not open what is under a closed value", () => {
    expect(rowsOf(["\u0000a\u0000b"])).toEqual([
      [0, "a"],
      [0, "c"],
      [0, "d"],
    ]);
  });

  it("shows a root that is no container, or an empty one, as one row", () => {
    expect(visibleRows(parseJson("3"), () => true)).toEqual([
      { path: "", depth: 0, label: null, value: { kind: "number", text: "3" } },
    ]);
    expect(visibleRows(parseJson("{}"), () => true)).toHaveLength(1);
  });
});

describe("find in the tree", () => {
  const root = parseJson('{"name": "fox", "list": ["a fox", {"fox": true}], "n": 12, "": null}');
  const rows = visibleRows(root, () => true);
  const find = (query: string, caseSensitive = false) =>
    treeMatches(rows, (text) => findMatches(text, query, caseSensitive, 100));

  it("shows keys and values as their rows do", () => {
    expect(labelText("")).toBe('""');
    expect(labelText("a\tb")).toBe('"a\\tb"');
    expect(labelText(3)).toBe("3");
    expect(valueText({ kind: "string", value: "x" })).toBe('"x"');
    expect(valueText({ kind: "number", text: "1e400" })).toBe("1e400");
    expect(valueText({ kind: "boolean", value: false })).toBe("false");
    expect(valueText({ kind: "null" })).toBe("null");
    expect(valueText({ kind: "array", items: [] })).toBeNull();
  });

  it("finds in keys and values alike, closed ones too, in order", () => {
    expect(find("fox").map((m) => [rows[m.row]?.label, m.part, m.start, m.end])).toEqual([
      ["name", "value", 1, 4],
      [0, "value", 3, 6],
      ["fox", "label", 0, 3],
    ]);
    expect(find("FOX", true)).toEqual([]);
  });

  it("does not run from one key or value into the next", () => {
    // "n" then 12: no match across the two.
    expect(find("n12")).toEqual([]);
    expect(find("12").map((m) => m.part)).toEqual(["value"]);
  });

  it("names the objects and arrays a row is in", () => {
    const fox = rows.find((row) => row.label === "fox");
    expect(fox && ancestorPaths(fox.path)).toEqual(["\u0000list", "\u0000list\u00001"]);
    expect(ancestorPaths("\u0000name")).toEqual([]);
  });
});
