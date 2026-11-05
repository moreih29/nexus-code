import { describe, expect, it } from "bun:test";
import {
  columnWidths,
  delimiterFor,
  parseDelimited,
} from "../../../../../src/renderer/services/editor/preview/delimited";

describe("parseDelimited", () => {
  it("reads rows and fields, the last line break making no row", () => {
    expect(parseDelimited("name,age\nKim,31\nLee,28\n", ",")).toEqual({
      rows: [
        ["name", "age"],
        ["Kim", "31"],
        ["Lee", "28"],
      ],
      columns: 2,
    });
  });

  it("takes quoted fields with delimiters, quotes and line breaks in them", () => {
    const { rows } = parseDelimited('a,"b, c","say ""hi""","two\nlines"\r\nx,"",y,z', ",");
    expect(rows).toEqual([
      ["a", "b, c", 'say "hi"', "two\nlines"],
      ["x", "", "y", "z"],
    ]);
  });

  it("keeps empty fields, ragged rows, \\r breaks, and drops a byte order mark", () => {
    const table = parseDelimited("﻿a,,c\rd\re,f,g,h", ",");
    expect(table.rows).toEqual([["a", "", "c"], ["d"], ["e", "f", "g", "h"]]);
    expect(table.columns).toBe(4);
    expect(parseDelimited('""', ",").rows).toEqual([[""]]);
    expect(parseDelimited("", ",").rows).toEqual([]);
  });

  it("splits on tabs for tab-separated values, leaving commas in fields", () => {
    expect(delimiterFor("/r/data.TSV")).toBe("\t");
    expect(delimiterFor("/r/data.csv")).toBe(",");
    expect(parseDelimited("a,1\tb\n", "\t").rows).toEqual([["a,1", "b"]]);
  });
});

describe("columnWidths", () => {
  it("is each column's widest field, wide characters counting two, within the bounds", () => {
    const table = parseDelimited(`id,이름,note\n1,김민수,${"x".repeat(80)}\n`, ",");
    expect(columnWidths(table)).toEqual([4, 6, 40]);
    expect(columnWidths(table, { min: 1, max: 10 })).toEqual([2, 6, 10]);
  });
});
