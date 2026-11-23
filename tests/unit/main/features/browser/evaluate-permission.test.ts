import { describe, expect, mock, test } from "bun:test";

const realElectron = await import("electron").catch(() => ({}));
mock.module("electron", () => ({
  ...realElectron,
  WebContentsView: class {},
}));

const { evaluatePermission } = await import("../../../../../src/main/features/browser/security");

function makeDeps(globalAllowed: boolean, remembered: "allow" | "block" | null) {
  return {
    getGlobalGrant: (_permission: string) => globalAllowed,
    getRemembered: (_ws: string, _origin: string, _permission: string) => remembered,
  };
}

const WS = "ws-1";
const ORIGIN = "https://example.com";

describe("evaluatePermission — auto classified", () => {
  test("clipboard-sanitized-write → allow (globalAllowed=false)", () => {
    expect(evaluatePermission(WS, ORIGIN, "clipboard-sanitized-write", makeDeps(false, null))).toBe(
      "allow",
    );
  });

  test("storage-access → allow", () => {
    expect(evaluatePermission(WS, ORIGIN, "storage-access", makeDeps(false, "block"))).toBe(
      "allow",
    );
  });

  test("top-level-storage-access → allow", () => {
    expect(evaluatePermission(WS, ORIGIN, "top-level-storage-access", makeDeps(false, null))).toBe(
      "allow",
    );
  });
});

describe("evaluatePermission — blocked classified", () => {
  test("'unknown' permission → block", () => {
    expect(evaluatePermission(WS, ORIGIN, "unknown", makeDeps(true, "allow"))).toBe("block");
  });

  test("unrecognised string → block", () => {
    expect(
      evaluatePermission(WS, ORIGIN, "totally-unknown-permission", makeDeps(true, "allow")),
    ).toBe("block");
  });
});

describe("evaluatePermission — prompt classified", () => {
  test.each([
    "geolocation",
    "media",
    "notifications",
    "fullscreen",
  ])("%s: globalAllowed=false, remembered=null → ask", (permission) => {
    expect(evaluatePermission(WS, ORIGIN, permission, makeDeps(false, null))).toBe("ask");
  });
});

describe("evaluatePermission — high-risk permissions default to ask", () => {
  const highRiskPermissions = ["openExternal", "fileSystem", "display-capture"] as const;

  for (const permission of highRiskPermissions) {
    test(`${permission}: globalAllowed=false, remembered=null → ask`, () => {
      expect(evaluatePermission(WS, ORIGIN, permission, makeDeps(false, null))).toBe("ask");
    });
  }
});
