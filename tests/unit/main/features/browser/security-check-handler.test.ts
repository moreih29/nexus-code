/**
 * Unit tests for installPermissionHandler — full-deps path.
 *
 * Verifies that setPermissionCheckHandler returns:
 *   - true  when evaluatePermission resolves to 'allow'
 *   - false when evaluatePermission resolves to 'ask'
 *   - false when evaluatePermission resolves to 'block'
 *
 * Also verifies that safeGetOrigin denies opaque/"null"/empty origins.
 *
 * DI-first approach: a fake session captures the registered handlers
 * without any mock.module call.  The electron leaf mock is only needed
 * because security.ts has a top-level `import type { WebContents, ... }`
 * that Bun resolves at import time.
 */

import { describe, expect, mock, test } from "bun:test";
import { mock as bunMock } from "bun:test";

// ---------------------------------------------------------------------------
// Electron leaf mock — required before importing security.ts.
// Only WebContentsView is needed (imported transitively via registry); the
// rest of the module is unused in these tests.
// ---------------------------------------------------------------------------

bunMock.module("electron", () => ({
  WebContentsView: class {},
}));

const { installPermissionHandler } = await import(
  "../../../../../src/main/features/browser/security"
);

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

interface FakeCheckHandler {
  (webContents: unknown, permission: string): boolean;
}

interface FakeRequestHandler {
  (webContents: unknown, permission: string, callback: (ok: boolean) => void): void;
}

interface FakeSession {
  _checkHandler: FakeCheckHandler | null;
  _requestHandler: FakeRequestHandler | null;
  setPermissionCheckHandler(h: FakeCheckHandler): void;
  setPermissionRequestHandler(h: FakeRequestHandler): void;
}

function makeFakeSession(): FakeSession {
  return {
    _checkHandler: null,
    _requestHandler: null,
    setPermissionCheckHandler(h) {
      this._checkHandler = h;
    },
    setPermissionRequestHandler(h) {
      this._requestHandler = h;
    },
  };
}

/**
 * Builds a fake WebContents whose getURL() returns `url`.
 * Used to drive safeGetOrigin inside the installed handler.
 */
function makeFakeWebContents(url: string): unknown {
  return {
    getURL: () => url,
    id: 1,
  };
}

/**
 * Constructs a minimal PermissionHandlerDeps that forces evaluatePermission
 * to the desired outcome for the given permission string.
 *
 * The prompt manager is wired but not needed for check-handler tests because
 * the check handler never calls promptManager.
 */
function makeDepsForDecision(decision: "allow" | "ask" | "block") {
  // decision mapping:
  //   allow  → globalAllowed=true  + prompt-class permission (geolocation)
  //   ask    → globalAllowed=false + remembered=null + prompt-class (geolocation)
  //   block  → use a truly blocked permission ("unknown")
  const fakePromptManager = {
    handlePermissionRequest: mock(() => {}),
    disposeByWebContents: mock(() => {}),
  };

  if (decision === "allow") {
    return {
      getGlobalGrant: () => true,
      getRemembered: () => null as "allow" | "block" | null,
      promptManager: fakePromptManager,
    };
  }

  if (decision === "ask") {
    return {
      getGlobalGrant: () => false,
      getRemembered: () => null as "allow" | "block" | null,
      promptManager: fakePromptManager,
    };
  }

  // decision === 'block': use remembered='block' so geolocation→block
  return {
    getGlobalGrant: () => false,
    getRemembered: () => "block" as "allow" | "block" | null,
    promptManager: fakePromptManager,
  };
}

const ATTRIBUTABLE_ORIGIN_URL = "https://example.com/page";
const PROMPT_PERMISSION = "geolocation"; // classifies as 'prompt'

// ---------------------------------------------------------------------------
// 1. setPermissionCheckHandler — full-deps path: allow → true
// ---------------------------------------------------------------------------

describe("installPermissionHandler (full-deps) — check handler", () => {
  test("allow decision → check handler returns true", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("allow");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );

    expect(session._checkHandler).not.toBeNull();
    const wc = makeFakeWebContents(ATTRIBUTABLE_ORIGIN_URL);
    const result = session._checkHandler!(wc, PROMPT_PERMISSION);
    expect(result).toBe(true);
  });

  test("ask decision → check handler returns false", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("ask");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );

    const wc = makeFakeWebContents(ATTRIBUTABLE_ORIGIN_URL);
    const result = session._checkHandler!(wc, PROMPT_PERMISSION);
    expect(result).toBe(false);
  });

  test("block decision → check handler returns false", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("block");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );

    const wc = makeFakeWebContents(ATTRIBUTABLE_ORIGIN_URL);
    const result = session._checkHandler!(wc, PROMPT_PERMISSION);
    expect(result).toBe(false);
  });

  test("null webContents → check handler returns false (origin deny)", () => {
    const session = makeFakeSession();
    const deps = makeDepsForDecision("allow");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );

    const result = session._checkHandler!(null, PROMPT_PERMISSION);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. safeGetOrigin — opaque/"null"/empty origin deny
//
// These are exercised through the check handler: origins that safeGetOrigin
// maps to null cause the handler to return false unconditionally.
// ---------------------------------------------------------------------------

describe("installPermissionHandler (full-deps) — opaque origin deny", () => {
  function installAndCheck(url: string, permission: string): boolean {
    const session = makeFakeSession();
    // Use allow-everything deps so that the only deny path is safeGetOrigin.
    const deps = makeDepsForDecision("allow");
    installPermissionHandler(
      session as unknown as import("electron").Session,
      deps as unknown as import("../../../../../src/main/features/browser/security").PermissionHandlerDeps,
    );
    const wc = makeFakeWebContents(url);
    return session._checkHandler!(wc, permission);
  }

  test("about:blank URL → origin 'null' → denied (false)", () => {
    // new URL("about:blank").origin === "null" (opaque)
    expect(installAndCheck("about:blank", PROMPT_PERMISSION)).toBe(false);
  });

  test("data: URL → origin 'null' → denied (false)", () => {
    // new URL("data:text/html,hi").origin === "null" (opaque)
    expect(installAndCheck("data:text/html,hi", PROMPT_PERMISSION)).toBe(false);
  });

  test("empty URL → denied (false)", () => {
    // getURL() returning '' → safeGetOrigin returns null
    expect(installAndCheck("", PROMPT_PERMISSION)).toBe(false);
  });

  test("https:// URL → attributable origin → NOT denied by safeGetOrigin", () => {
    // With allow deps this should return true; confirms the guard only fires
    // for opaque/empty origins.
    expect(installAndCheck(ATTRIBUTABLE_ORIGIN_URL, PROMPT_PERMISSION)).toBe(true);
  });
});
