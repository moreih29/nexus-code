/**
 * Find in a preview: where a query is in the text, and the finder the HTML
 * preview runs in its own document from its source.
 */
import { describe, expect, test } from "bun:test";
import { createDomFinder } from "../../../../../../src/renderer/services/editor/preview/find/dom-finder";
import { findMatches } from "../../../../../../src/renderer/services/editor/preview/find/find-matches";

describe("findMatches", () => {
  test("the query is text, not a pattern", () => {
    expect(findMatches("a.b axb (c) [d] $e", "a.b", false, 100)).toEqual([0, 3]);
    expect(findMatches("a.b axb (c) [d] $e", "(c)", false, 100)).toEqual([8, 11]);
    expect(findMatches("a.b axb (c) [d] $e", "[d] $e", false, 100)).toEqual([12, 18]);
    expect(findMatches("x/y-z", "/y-", false, 100)).toEqual([1, 4]);
  });
});

test("both run from their source alone, as the HTML preview runs them", () => {
  const match = new Function(`return ${findMatches.toString()}`)() as typeof findMatches;
  expect(match("Foo foo", "FOO", false, 10)).toEqual([0, 3, 4, 7]);
  const create = new Function(`return ${createDomFinder.toString()}`)();
  expect(typeof create).toBe("function");
});
