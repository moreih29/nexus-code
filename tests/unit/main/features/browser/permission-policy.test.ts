/**
 * Unit tests for the pure permission resolver.
 *
 * No mocking required — resolvePermission is a pure function with no
 * external dependencies.  Every test exercises a specific cell in the
 * decision table defined by the five-step priority chain.
 *
 * Decision table
 * ┌────────────────────┬───────────────┬───────────────┬──────────────┐
 * │ isKnownPermission  │ globalAllowed │  remembered   │   result     │
 * ├────────────────────┼───────────────┼───────────────┼──────────────┤
 * │ false              │ any           │ any           │ "block"      │
 * │ true               │ true          │ "allow"       │ "allow"      │
 * │ true               │ true          │ "block"       │ "allow"  (!) │
 * │ true               │ true          │ null          │ "allow"      │
 * │ true               │ false         │ "allow"       │ "allow"      │
 * │ true               │ false         │ "block"       │ "block"      │
 * │ true               │ false         │ null          │ "ask"        │
 * └────────────────────┴───────────────┴───────────────┴──────────────┘
 */

import { describe, expect, test } from "bun:test";
import {
  type PermissionDecision,
  type PermissionResolverInput,
  resolvePermission,
} from "../../../../../src/main/features/browser/permission-policy";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function resolve(input: PermissionResolverInput): PermissionDecision {
  return resolvePermission(input);
}

// ---------------------------------------------------------------------------
// 1. Unknown permission — always block regardless of other inputs
// ---------------------------------------------------------------------------

describe("resolvePermission — unknown permission", () => {
  test("blocks when isKnownPermission=false, globalAllowed=false, remembered=null", () => {
    expect(resolve({ isKnownPermission: false, globalAllowed: false, remembered: null })).toBe("block");
  });

  test("blocks when isKnownPermission=false, globalAllowed=true, remembered=null", () => {
    expect(resolve({ isKnownPermission: false, globalAllowed: true, remembered: null })).toBe("block");
  });

  test("blocks when isKnownPermission=false, globalAllowed=false, remembered='allow'", () => {
    expect(resolve({ isKnownPermission: false, globalAllowed: false, remembered: "allow" })).toBe("block");
  });

  test("blocks when isKnownPermission=false, globalAllowed=true, remembered='allow'", () => {
    expect(resolve({ isKnownPermission: false, globalAllowed: true, remembered: "allow" })).toBe("block");
  });

  test("blocks when isKnownPermission=false, globalAllowed=false, remembered='block'", () => {
    expect(resolve({ isKnownPermission: false, globalAllowed: false, remembered: "block" })).toBe("block");
  });

  test("blocks when isKnownPermission=false, globalAllowed=true, remembered='block'", () => {
    expect(resolve({ isKnownPermission: false, globalAllowed: true, remembered: "block" })).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 2. Global allow ON — supersedes remembered block (key conflict case)
// ---------------------------------------------------------------------------

describe("resolvePermission — globalAllowed=true", () => {
  test("allows when globalAllowed=true, remembered='allow'", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: true, remembered: "allow" })).toBe("allow");
  });

  test("allows when globalAllowed=true, remembered='block' [global beats remembered block]", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: true, remembered: "block" })).toBe("allow");
  });

  test("allows when globalAllowed=true, remembered=null", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: true, remembered: null })).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 3–5. Global allow OFF — remembered and fallback
// ---------------------------------------------------------------------------

describe("resolvePermission — globalAllowed=false", () => {
  test("allows when remembered='allow'", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: false, remembered: "allow" })).toBe("allow");
  });

  test("blocks when remembered='block'", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: false, remembered: "block" })).toBe("block");
  });

  test("asks when remembered=null (no prior decision)", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: false, remembered: null })).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Key conflict — explicit assertion that global ON beats remembered block
// ---------------------------------------------------------------------------

describe("resolvePermission — key conflict: globalAllowed=true vs remembered='block'", () => {
  test("returns 'allow', not 'block'", () => {
    const result = resolve({ isKnownPermission: true, globalAllowed: true, remembered: "block" });
    expect(result).toBe("allow");
    expect(result).not.toBe("block");
  });
});
