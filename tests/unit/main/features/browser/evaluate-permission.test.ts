/**
 * Unit tests for evaluatePermission (exported from security.ts).
 *
 * Uses the DI seam: getGlobalGrant and getRemembered are injected as plain
 * functions; no Electron import or mock.module required.
 *
 * Decision matrix:
 *
 *   classifyPermission result | globalAllowed | remembered  | expected
 *   ─────────────────────────────────────────────────────────────────────
 *   auto (e.g. clipboard-sanitized-write) | any   | any         | allow
 *   blocked (e.g. unknown)               | any   | any         | block
 *   blocked (unrecognised string)        | any   | any         | block
 *   prompt (e.g. geolocation)            | true  | any         | allow
 *   prompt                               | false | "allow"     | allow
 *   prompt                               | false | "block"     | block
 *   prompt                               | false | null        | ask
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Electron mock — must come before importing security.ts
// ---------------------------------------------------------------------------

import { mock } from "bun:test";

const realElectron = await import("electron").catch(() => ({}));
mock.module("electron", () => ({
  ...realElectron,
  WebContentsView: class {},
}));

const { evaluatePermission } = await import(
  "../../../../../src/main/features/browser/security"
);

// ---------------------------------------------------------------------------
// Fake deps factory
// ---------------------------------------------------------------------------

function makeDeps(globalAllowed: boolean, remembered: "allow" | "block" | null) {
  return {
    getGlobalGrant: (_permission: string) => globalAllowed,
    getRemembered: (_ws: string, _origin: string, _permission: string) => remembered,
  };
}

const WS = "ws-1";
const ORIGIN = "https://example.com";

// ---------------------------------------------------------------------------
// 1. auto permissions — always allow
// ---------------------------------------------------------------------------

describe("evaluatePermission — auto classified", () => {
  test("clipboard-sanitized-write → allow (globalAllowed=false)", () => {
    expect(evaluatePermission(WS, ORIGIN, "clipboard-sanitized-write", makeDeps(false, null))).toBe("allow");
  });

  test("storage-access → allow", () => {
    expect(evaluatePermission(WS, ORIGIN, "storage-access", makeDeps(false, "block"))).toBe("allow");
  });

  test("top-level-storage-access → allow", () => {
    expect(evaluatePermission(WS, ORIGIN, "top-level-storage-access", makeDeps(false, null))).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 2. blocked permissions — always block
// ---------------------------------------------------------------------------

describe("evaluatePermission — blocked classified", () => {
  test("'unknown' permission → block", () => {
    expect(evaluatePermission(WS, ORIGIN, "unknown", makeDeps(true, "allow"))).toBe("block");
  });

  test("unrecognised string → block", () => {
    expect(evaluatePermission(WS, ORIGIN, "totally-unknown-permission", makeDeps(true, "allow"))).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 3. prompt permissions with globalAllowed=true → always allow
// ---------------------------------------------------------------------------

describe("evaluatePermission — prompt + globalAllowed=true", () => {
  test("geolocation, remembered=null → allow", () => {
    expect(evaluatePermission(WS, ORIGIN, "geolocation", makeDeps(true, null))).toBe("allow");
  });

  test("geolocation, remembered='block' → allow (global beats remembered)", () => {
    expect(evaluatePermission(WS, ORIGIN, "geolocation", makeDeps(true, "block"))).toBe("allow");
  });

  test("notifications, remembered='allow' → allow", () => {
    expect(evaluatePermission(WS, ORIGIN, "notifications", makeDeps(true, "allow"))).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 4. prompt permissions with globalAllowed=false, remembered='allow' → allow
// ---------------------------------------------------------------------------

describe("evaluatePermission — prompt + globalAllowed=false + remembered=allow", () => {
  test("media → allow", () => {
    expect(evaluatePermission(WS, ORIGIN, "media", makeDeps(false, "allow"))).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 5. prompt permissions with globalAllowed=false, remembered='block' → block
// ---------------------------------------------------------------------------

describe("evaluatePermission — prompt + globalAllowed=false + remembered=block", () => {
  test("media → block", () => {
    expect(evaluatePermission(WS, ORIGIN, "media", makeDeps(false, "block"))).toBe("block");
  });

  test("geolocation → block", () => {
    expect(evaluatePermission(WS, ORIGIN, "geolocation", makeDeps(false, "block"))).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// 6. prompt permissions with globalAllowed=false, remembered=null → ask
// ---------------------------------------------------------------------------

describe("evaluatePermission — prompt + globalAllowed=false + remembered=null", () => {
  test("media → ask", () => {
    expect(evaluatePermission(WS, ORIGIN, "media", makeDeps(false, null))).toBe("ask");
  });

  test("notifications → ask", () => {
    expect(evaluatePermission(WS, ORIGIN, "notifications", makeDeps(false, null))).toBe("ask");
  });

  test("fullscreen → ask", () => {
    expect(evaluatePermission(WS, ORIGIN, "fullscreen", makeDeps(false, null))).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// 7. High-risk permissions are 'ask' by default (globalAllowed=false, remembered=null)
//
// Security lock: openExternal, fileSystem, and display-capture must never
// silently auto-allow or auto-block — they must surface a prompt.  If any of
// these accidentally falls into the 'auto' or 'blocked' classification, this
// group will fail immediately, preventing silent security regressions.
// ---------------------------------------------------------------------------

describe("evaluatePermission — high-risk permissions default to ask", () => {
  const highRiskPermissions = [
    "openExternal",
    "fileSystem",
    "display-capture",
  ] as const;

  for (const permission of highRiskPermissions) {
    test(`${permission}: globalAllowed=false, remembered=null → ask`, () => {
      expect(evaluatePermission(WS, ORIGIN, permission, makeDeps(false, null))).toBe("ask");
    });
  }

  test("openExternal: globalAllowed=true → allow (global override respected)", () => {
    expect(evaluatePermission(WS, ORIGIN, "openExternal", makeDeps(true, null))).toBe("allow");
  });

  test("fileSystem: globalAllowed=false, remembered=block → block (explicit block respected)", () => {
    expect(evaluatePermission(WS, ORIGIN, "fileSystem", makeDeps(false, "block"))).toBe("block");
  });

  test("display-capture: globalAllowed=false, remembered=allow → allow (explicit allow respected)", () => {
    expect(evaluatePermission(WS, ORIGIN, "display-capture", makeDeps(false, "allow"))).toBe("allow");
  });
});
