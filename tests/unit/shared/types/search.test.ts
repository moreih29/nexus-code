import { describe, expect, test } from "bun:test";
import { MAX_SEARCHABLE_FILE_SIZE } from "../../../../src/shared/fs-defaults";
import { ipcContract } from "../../../../src/shared/ipc-contract";
import { TextSearchQuerySchema } from "../../../../src/shared/types/search";

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

  test("accepts boolean false explicitly for the three flags", () => {
    const result = TextSearchQuerySchema.parse({
      pattern: "x",
      isRegExp: false,
      isCaseSensitive: false,
      isWordMatch: false,
    });
    expect(result.isRegExp).toBe(false);
    expect(result.isCaseSensitive).toBe(false);
    expect(result.isWordMatch).toBe(false);
  });
});

describe("ipcContract.fs search entries", () => {
  test("searchText call args parse valid payload", () => {
    const result = ipcContract.fs.call.searchText.args.parse({
      workspaceId: "12345678-1234-1234-1234-123456789012",
      query: { pattern: "foo" },
    });
    expect(result.query.pattern).toBe("foo");
    expect(result.query.maxResults).toBe(2000);
  });

  test("searchProgress listen args parse valid payload", () => {
    const result = ipcContract.fs.listen.searchProgress.args.parse({
      requestId: "req-1",
      batch: [
        {
          relPath: "src/index.ts",
          matches: [{ range: { line: 0, startCol: 0, endCol: 3 }, preview: "foo bar" }],
        },
      ],
    });
    expect(result.requestId).toBe("req-1");
    expect(result.batch).toHaveLength(1);
  });
});
