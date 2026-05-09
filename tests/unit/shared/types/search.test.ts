import { describe, expect, test } from "bun:test";
import { MAX_SEARCHABLE_FILE_SIZE } from "../../../../src/shared/fs-defaults";
import { ipcContract } from "../../../../src/shared/ipc-contract";
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

describe("ipcContract.fs search stream entries", () => {
  test("searchText moved from call/listen to stream", () => {
    expect("searchText" in ipcContract.fs.call).toBe(false);
    expect("searchProgress" in ipcContract.fs.listen).toBe(false);
    expect("searchText" in ipcContract.fs.stream).toBe(true);
  });

  test("searchText stream args parse valid payload", () => {
    const result = ipcContract.fs.stream.searchText.args.parse({
      workspaceId: "12345678-1234-1234-1234-123456789012",
      query: { pattern: "foo" },
    });

    expect(result.query.pattern).toBe("foo");
    expect(result.query.maxResults).toBe(2000);
  });

  test("searchText stream progress parses FileMatch[] batches", () => {
    const result = ipcContract.fs.stream.searchText.progress.parse([
      {
        relPath: "src/index.ts",
        matches: [{ range: { line: 0, startCol: 0, endCol: 3 }, preview: "foo bar" }],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].relPath).toBe("src/index.ts");
  });

  test("searchText stream result parses SearchComplete", () => {
    const result = ipcContract.fs.stream.searchText.result.parse({
      filesScanned: 3,
      matchesFound: 4,
      limitHit: false,
      elapsedMs: 12,
    });

    expect(result).toEqual({ filesScanned: 3, matchesFound: 4, limitHit: false, elapsedMs: 12 });
  });
});
