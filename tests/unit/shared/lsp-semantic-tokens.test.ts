import { describe, expect, test } from "bun:test";
import {
  CANONICAL_TOKEN_TYPES,
  remapSemanticTokenData,
  SENTINEL_TOKEN_TYPE_INDEX,
} from "../../../src/shared/lsp/semantic-tokens";

// ---------------------------------------------------------------------------
// remapSemanticTokenData — unit tests
// ---------------------------------------------------------------------------

describe("remapSemanticTokenData", () => {
  // Build a minimal server legend in non-standard order so that we can
  // verify the remap is actually doing positional translation, not a no-op.
  // Server legend: ["function", "variable", "type", "property"]
  //   index 0 → "function"
  //   index 1 → "variable"
  //   index 2 → "type"
  //   index 3 → "property"
  const SERVER_LEGEND = ["function", "variable", "type", "property"];

  // Canonical positions (from CANONICAL_TOKEN_TYPES):
  //   "function"  → 12
  //   "variable"  → 8
  //   "type"      → 1
  //   "property"  → 9
  const CANONICAL_FUNCTION = CANONICAL_TOKEN_TYPES.indexOf("function");
  const CANONICAL_VARIABLE = CANONICAL_TOKEN_TYPES.indexOf("variable");
  const CANONICAL_TYPE = CANONICAL_TOKEN_TYPES.indexOf("type");
  const CANONICAL_PROPERTY = CANONICAL_TOKEN_TYPES.indexOf("property");

  test("remaps a single token from server index to canonical index", () => {
    // Server index 0 = "function" → canonical index for "function"
    const data = [0, 0, 3, 0, 0]; // one token: typeIndex=0 (function)
    const result = remapSemanticTokenData(data, SERVER_LEGEND, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 3, CANONICAL_FUNCTION, 0]);
  });

  test("remaps multiple tokens each to correct canonical indices", () => {
    // Two tokens: typeIndex=1 (variable) and typeIndex=2 (type)
    const data = [
      0,
      0,
      4,
      1,
      0, // variable
      0,
      5,
      2,
      2,
      0, // type
    ];
    const result = remapSemanticTokenData(data, SERVER_LEGEND, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 4, CANONICAL_VARIABLE, 0, 0, 5, 2, CANONICAL_TYPE, 0]);
  });

  test("maps out-of-bounds server type index to sentinel — tuple kept in output", () => {
    // typeIndex=99 is out of bounds in SERVER_LEGEND → sentinel, not dropped
    const data = [0, 0, 5, 99, 0];
    const result = remapSemanticTokenData(data, SERVER_LEGEND, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 5, SENTINEL_TOKEN_TYPE_INDEX, 0]);
  });

  test("maps unknown server type name to sentinel — tuple kept in output", () => {
    // A server legend containing a name unknown to the canonical list
    const serverWithUnknown = ["unknownType", "function"];
    const data = [
      0,
      0,
      3,
      0,
      0, // unknownType → sentinel (kept)
      0,
      4,
      2,
      1,
      0, // function → kept with canonical index
    ];
    const result = remapSemanticTokenData(data, serverWithUnknown, CANONICAL_TOKEN_TYPES);
    // Both tuples survive; unknownType gets the sentinel index
    expect(result).toEqual([0, 0, 3, SENTINEL_TOKEN_TYPE_INDEX, 0, 0, 4, 2, CANONICAL_FUNCTION, 0]);
  });

  test("unmapped token sandwiched between mapped tokens — delta chain stays intact", () => {
    // Three tokens: function (line 0), unknownType (line 1), variable (line 2).
    // The unknown middle token MUST remain in the output so the variable's
    // deltaLine=1 is still relative to the unknown token, not the function.
    const serverWithUnknown = ["function", "unknownType", "variable"];
    const data = [
      // token 0: line 0, char 0, len 3 — function
      0, 0, 3, 0, 0,
      // token 1: line+1, char 0, len 5 — unknownType (middle, unmapped)
      1, 0, 5, 1, 0,
      // token 2: line+1, char 2, len 4 — variable (after unknown)
      1, 2, 4, 2, 0,
    ];
    const result = remapSemanticTokenData(data, serverWithUnknown, CANONICAL_TOKEN_TYPES);

    // (a) output length equals input length — no tuples removed
    expect(result).toHaveLength(data.length);

    // (b) unmapped middle token gets the sentinel index
    expect(result[8]).toBe(SENTINEL_TOKEN_TYPE_INDEX); // index 3 of tuple 1

    // (c) the token after the unknown one keeps its original deltaLine and
    //     deltaStartChar unchanged — positions are not shifted
    expect(result[10]).toBe(1); // deltaLine of tuple 2
    expect(result[11]).toBe(2); // deltaStartChar of tuple 2
    expect(result[13]).toBe(CANONICAL_VARIABLE); // type index of tuple 2
  });

  test("passes modifier bits through unchanged", () => {
    const data = [1, 2, 3, 3, 7]; // typeIndex=3 (property), modifierBits=7
    const result = remapSemanticTokenData(data, SERVER_LEGEND, CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([1, 2, 3, CANONICAL_PROPERTY, 7]);
  });

  test("returns empty array for empty input", () => {
    expect(remapSemanticTokenData([], SERVER_LEGEND, CANONICAL_TOKEN_TYPES)).toEqual([]);
  });

  test("maps to sentinel when server legend is empty (all indices out-of-bounds)", () => {
    // With an empty server legend every index is out-of-bounds → sentinel
    const data = [0, 0, 4, 0, 0];
    const result = remapSemanticTokenData(data, [], CANONICAL_TOKEN_TYPES);
    expect(result).toEqual([0, 0, 4, SENTINEL_TOKEN_TYPE_INDEX, 0]);
  });

  test("is a no-op when server legend matches canonical order exactly", () => {
    // Build data that references the first 3 canonical types
    const data = [
      0,
      0,
      1,
      0,
      0, // canonical[0] = "namespace"
      0,
      2,
      2,
      1,
      0, // canonical[1] = "type"
      0,
      3,
      3,
      2,
      0, // canonical[2] = "class"
    ];
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

  test("CANONICAL_TOKEN_TYPES contains the standard LSP 3.16 types", () => {
    // Spot-check that key types are present at the expected positions
    expect(CANONICAL_TOKEN_TYPES[0]).toBe("namespace");
    expect(CANONICAL_TOKEN_TYPES[12]).toBe("function");
    expect(CANONICAL_TOKEN_TYPES[8]).toBe("variable");
    expect(CANONICAL_TOKEN_TYPES[15]).toBe("keyword");
    expect(CANONICAL_TOKEN_TYPES[17]).toBe("comment");
    expect(CANONICAL_TOKEN_TYPES[18]).toBe("string");
  });
});
