/**
 * Find in a preview: where a query is in the text, and the finder the HTML
 * preview runs in its own document from its source.
 */
import { describe, expect, test } from "bun:test";
import { createDomFinder } from "../../../../../../src/renderer/services/editor/preview/find/dom-finder";
import { findMatches } from "../../../../../../src/renderer/services/editor/preview/find/find-matches";

describe("findMatches", () => {
  test("finds every match, either case unless asked", () => {
    expect(findMatches("Foo foo FOO", "foo", false, 100)).toEqual([0, 3, 4, 7, 8, 11]);
    expect(findMatches("Foo foo FOO", "foo", true, 100)).toEqual([4, 7]);
    expect(findMatches("Ärger ärger", "ärger", false, 100)).toEqual([0, 5, 6, 11]);
  });

  test("a space matches any run of white space, as the page shows one", () => {
    expect(findMatches("one\n   two", "one two", false, 100)).toEqual([0, 10]);
    // NUL parts blocks: no match runs from one into the next.
    expect(findMatches("one\u0000two", "one two", false, 100)).toEqual([]);
    expect(findMatches("one\u0000two", "onetwo", false, 100)).toEqual([]);
  });

  test("the query is text, not a pattern", () => {
    expect(findMatches("a.b axb (c) [d] $e", "a.b", false, 100)).toEqual([0, 3]);
    expect(findMatches("a.b axb (c) [d] $e", "(c)", false, 100)).toEqual([8, 11]);
    expect(findMatches("a.b axb (c) [d] $e", "[d] $e", false, 100)).toEqual([12, 18]);
    expect(findMatches("x/y-z", "/y-", false, 100)).toEqual([1, 4]);
  });

  test("nothing for a blank query, and no more than the limit", () => {
    expect(findMatches("abc", "  ", false, 100)).toEqual([]);
    expect(findMatches("aaaa", "a", false, 2)).toEqual([0, 1, 1, 2]);
  });
});

test("both run from their source alone, as the HTML preview runs them", () => {
  const match = new Function(`return ${findMatches.toString()}`)() as typeof findMatches;
  expect(match("Foo foo", "FOO", false, 10)).toEqual([0, 3, 4, 7]);
  const create = new Function(`return ${createDomFinder.toString()}`)();
  expect(typeof create).toBe("function");
});
