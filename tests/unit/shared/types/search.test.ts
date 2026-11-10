import { describe, expect, test } from "bun:test";
import { SearchProgressSchema } from "../../../../src/shared/search/types";

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

  test("keeps previewStart for previews cut from long lines", () => {
    const result = SearchProgressSchema.parse([
      {
        relPath: "data.json",
        matches: [
          { range: { line: 0, startCol: 900, endCol: 902 }, preview: "x ab y", previewStart: 898 },
        ],
      },
    ]);

    expect(result[0].matches[0].previewStart).toBe(898);
  });
});
