import { describe, expect, test } from "bun:test";
import {
  JsonSyntaxError,
  visibleRows,
} from "../../../../../../src/renderer/services/editor/preview/json-tree";
import { parseYaml } from "../../../../../../src/renderer/services/editor/preview/yaml-tree";

describe("parseYaml", () => {
  test("keys keep their written order, a number key and a repeated key included", () => {
    const root = parseYaml("b: 1\n2: two\n1: one\n007: x\nb: again\n");
    expect(root.kind === "object" && root.entries.map((e) => e.key)).toEqual([
      "b",
      "2",
      "1",
      "007",
      "b",
    ]);
  });

  test("values read as their kinds, numbers as written", () => {
    expect(parseYaml("a: 0x1F\nb: true\nc: ~\nd: hello\ne: [1, 2]\nf: .inf\n")).toEqual({
      kind: "object",
      entries: [
        { key: "a", value: { kind: "number", text: "0x1F" } },
        { key: "b", value: { kind: "boolean", value: true } },
        { key: "c", value: { kind: "null" } },
        { key: "d", value: { kind: "string", value: "hello" } },
        {
          key: "e",
          value: {
            kind: "array",
            items: [
              { kind: "number", text: "1" },
              { kind: "number", text: "2" },
            ],
          },
        },
        { key: "f", value: { kind: "number", text: ".inf" } },
      ],
    });
  });

  test("an alias shows what its anchor names; one inside it shows as the alias", () => {
    const root = parseYaml("base: &b {x: 1}\nuse: *b\nloop: &l [1, *l]\n");
    expect(root).toEqual({
      kind: "object",
      entries: [
        {
          key: "base",
          value: { kind: "object", entries: [{ key: "x", value: { kind: "number", text: "1" } }] },
        },
        {
          key: "use",
          value: { kind: "object", entries: [{ key: "x", value: { kind: "number", text: "1" } }] },
        },
        {
          key: "loop",
          value: {
            kind: "array",
            items: [
              { kind: "number", text: "1" },
              { kind: "string", value: "*l" },
            ],
          },
        },
      ],
    });
    // Opening every row ends.
    expect(visibleRows(root, () => true)).toHaveLength(7);
  });

  test("several documents are a list of them; comments alone are null", () => {
    expect(parseYaml("---\na: 1\n---\n- 2\n")).toEqual({
      kind: "array",
      items: [
        { kind: "object", entries: [{ key: "a", value: { kind: "number", text: "1" } }] },
        { kind: "array", items: [{ kind: "number", text: "2" }] },
      ],
    });
    expect(parseYaml("# nothing here\n")).toEqual({ kind: "null" });
  });

  test("a mistake says where it is", () => {
    let error: unknown;
    try {
      parseYaml("a: 1\nb: [1, 2\nc: 3\n");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JsonSyntaxError);
    expect((error as JsonSyntaxError).line).toBeGreaterThanOrEqual(2);
  });
});
