import { describe, expect, test } from "bun:test";
import {
  type PermissionDecision,
  type PermissionResolverInput,
  resolvePermission,
} from "../../../../../src/main/features/browser/permission-policy";

function resolve(input: PermissionResolverInput): PermissionDecision {
  return resolvePermission(input);
}

describe("resolvePermission — unknown permission", () => {
  test.each([
    [false, null],
    [true, null],
    [false, "allow"],
    [true, "allow"],
    [false, "block"],
    [true, "block"],
  ] as const)("blocks when isKnownPermission=false, globalAllowed=%p, remembered=%p", (globalAllowed, remembered) => {
    expect(resolve({ isKnownPermission: false, globalAllowed, remembered })).toBe("block");
  });
});

describe("resolvePermission — globalAllowed=true", () => {
  test("allows when globalAllowed=true, remembered='allow'", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: true, remembered: "allow" })).toBe(
      "allow",
    );
  });

  test("allows when globalAllowed=true, remembered='block' [global beats remembered block]", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: true, remembered: "block" })).toBe(
      "allow",
    );
  });

  test("allows when globalAllowed=true, remembered=null", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: true, remembered: null })).toBe(
      "allow",
    );
  });
});

describe("resolvePermission — globalAllowed=false", () => {
  test("allows when remembered='allow'", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: false, remembered: "allow" })).toBe(
      "allow",
    );
  });

  test("blocks when remembered='block'", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: false, remembered: "block" })).toBe(
      "block",
    );
  });

  test("asks when remembered=null (no prior decision)", () => {
    expect(resolve({ isKnownPermission: true, globalAllowed: false, remembered: null })).toBe(
      "ask",
    );
  });
});
