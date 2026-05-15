import { describe, expect, test } from "bun:test";
import { MAX_SEARCHABLE_FILE_SIZE } from "../../../../src/shared/fs/defaults";
import { SearchProgressSchema, TextSearchQuerySchema } from "../../../../src/shared/types/search";

describe("TextSearchQuerySchema", () => {
  test("parses minimal {pattern: 'x'} and fills defaults", () => {
    const result = TextSearchQuerySchema.parse({ pattern: "x" });
    expect(result.pattern).toBe("x");
    expect(result.isRegExp).toBe(false);
    expect(result.isCaseSensitive).toBe(false);
    expect(result.isWordMatch).toBe(false);
    expect(result.includes).toEqual([]);
    expect(result.excludes).toEqual([]);
    expect(result.maxResults).toBe(2000);
    expect(result.maxFileSize).toBe(MAX_SEARCHABLE_FILE_SIZE);
  });

  test("rejects empty pattern (min(1))", () => {
    expect(TextSearchQuerySchema.safeParse({ pattern: "" }).success).toBe(false);
  });

  test("rejects maxResults > 20000", () => {
    expect(TextSearchQuerySchema.safeParse({ pattern: "x", maxResults: 20001 }).success).toBe(
      false,
    );
  });
});

describe("SearchProgressSchema", () => {
  test("parses a FileMatch[] batch without request transport metadata", () => {
    const result = SearchProgressSchema.parse([
      {
        relPath: "src/index.ts",
        matches: [{ range: { line: 0, startCol: 0, endCol: 3 }, preview: "foo bar" }],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].relPath).toBe("src/index.ts");
    expect(result[0].matches).toHaveLength(1);
    expect("requestId" in result[0]).toBe(false);
  });
});
