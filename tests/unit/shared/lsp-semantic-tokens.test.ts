import { describe, expect, test } from "bun:test";
import {
  CANONICAL_TOKEN_TYPES,
  remapSemanticTokenData,
  SENTINEL_TOKEN_TYPE_INDEX,
} from "../../../src/shared/lsp/semantic-tokens";

describe("remapSemanticTokenData", () => {
  const SERVER_LEGEND = ["function", "variable", "type", "property"];

  const CANONICAL_FUNCTION = CANONICAL_TOKEN_TYPES.indexOf("function");
  const CANONICAL_VARIABLE = CANONICAL_TOKEN_TYPES.indexOf("variable");
  const CANONICAL_TYPE = CANONICAL_TOKEN_TYPES.indexOf("type");
  const CANONICAL_PROPERTY = CANONICAL_TOKEN_TYPES.indexOf("property");

  test("remaps a single token from server index to canonical index", () => {
    const data = [0, 0, 3, 0, 0];
    const result = remapSemanticTokenData(data, SERVER_LEGEND, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 3, CANONICAL_FUNCTION, 0]);
  });

  test("remaps multiple tokens each to correct canonical indices", () => {
    const data = [0, 0, 4, 1, 0, 0, 5, 2, 2, 0];
    const result = remapSemanticTokenData(data, SERVER_LEGEND, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 4, CANONICAL_VARIABLE, 0, 0, 5, 2, CANONICAL_TYPE, 0]);
  });

  test("maps out-of-bounds server type index to sentinel — tuple kept in output", () => {
    const data = [0, 0, 5, 99, 0];
    const result = remapSemanticTokenData(data, SERVER_LEGEND, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 5, SENTINEL_TOKEN_TYPE_INDEX, 0]);
  });

  test("maps unknown server type name to sentinel — tuple kept in output", () => {
    const serverWithUnknown = ["unknownType", "function"];
    const data = [0, 0, 3, 0, 0, 0, 4, 2, 1, 0];
    const result = remapSemanticTokenData(data, serverWithUnknown, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 3, SENTINEL_TOKEN_TYPE_INDEX, 0, 0, 4, 2, CANONICAL_FUNCTION, 0]);
  });

  test("unmapped token sandwiched between mapped tokens — delta chain stays intact", () => {
    const serverWithUnknown = ["function", "unknownType", "variable"];
    const data = [0, 0, 3, 0, 0, 1, 0, 5, 1, 0, 1, 2, 4, 2, 0];
    const result = remapSemanticTokenData(data, serverWithUnknown, CANONICAL_TOKEN_TYPES);

    expect(result).toHaveLength(data.length);

    expect(result[8]).toBe(SENTINEL_TOKEN_TYPE_INDEX);

    expect(result[10]).toBe(1);
    expect(result[11]).toBe(2);
    expect(result[13]).toBe(CANONICAL_VARIABLE);
  });

  test("passes modifier bits through unchanged", () => {
    const data = [1, 2, 3, 3, 7];
    const result = remapSemanticTokenData(data, SERVER_LEGEND, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([1, 2, 3, CANONICAL_PROPERTY, 7]);
  });

  test("returns empty array for empty input", () => {
    expect(remapSemanticTokenData([], SERVER_LEGEND, CANONICAL_TOKEN_TYPES)).toEqual([]);
  });

  test("maps to sentinel when server legend is empty (all indices out-of-bounds)", () => {
    const data = [0, 0, 4, 0, 0];
    const result = remapSemanticTokenData(data, [], CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 4, SENTINEL_TOKEN_TYPE_INDEX, 0]);
  });

  test("is a no-op when server legend matches canonical order exactly", () => {
    const data = [0, 0, 1, 0, 0, 0, 2, 2, 1, 0, 0, 3, 3, 2, 0];
    const result = remapSemanticTokenData(
      data,
      CANONICAL_TOKEN_TYPES as string[],
      CANONICAL_TOKEN_TYPES,
    );
    expect(result).toEqual(data);
  });

  test("CANONICAL_TOKEN_TYPES ends with the sentinel 'unknown'", () => {
    expect(CANONICAL_TOKEN_TYPES[SENTINEL_TOKEN_TYPE_INDEX]).toBe("unknown");
    expect(SENTINEL_TOKEN_TYPE_INDEX).toBe(CANONICAL_TOKEN_TYPES.length - 1);
  });
});
