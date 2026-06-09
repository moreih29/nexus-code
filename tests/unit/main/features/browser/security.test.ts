/**
 * Unit tests for browser tab security policy.
 *
 * Tests cover:
 *   1. Navigation guard — NAVIGATION_SCHEME_ALLOWLIST enforcement on will-navigate.
 *   2. will-frame-navigate guard — blocks data: for sub-frames, allows about:blank.
 *   3. setWindowOpenHandler policy — http/https same-tab navigate, others deny.
 *   4. Permission matrix — clipboard-sanitized-write allowed, everything else denied.
 *
 * All Electron APIs are mocked; no real WebContents or BrowserWindow is created.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Electron mock — must be set up before importing the module under test.
// ---------------------------------------------------------------------------

// Track calls for assertion
const mockSessionPermHandler:
  | ((wc: unknown, perm: string, cb: (ok: boolean) => void) => void)
  | null = null;

mock.module("electron", () => ({
  WebContentsView: class {},
}));

// Lazy import after mock registration
const { buildBrowserTabWebPreferences, installPermissionHandler, installNavigationGuards } =
  await import("../../../../../src/main/features/browser/security");

// ---------------------------------------------------------------------------
// Helpers — fake WebContents and Session factories
// ---------------------------------------------------------------------------

interface FakeEvent {
  prevented: boolean;
  preventDefault(): void;
}

function makeFakeEvent(): FakeEvent {
  const ev = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  return ev;
}

type EventHandler = (...args: unknown[]) => void;

interface FakeWebContents {
  _handlers: Map<string, EventHandler[]>;
  on(event: string, handler: EventHandler): void;
  setWindowOpenHandler(
    handler: (details: { url: string }) => {
      action: string;
      overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown> };
    },
  ): void;
  _windowOpenHandler:
    | ((details: { url: string }) => {
        action: string;
        overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown> };
      })
    | null;
  _loadURLCalls: string[];
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
  };
  emit(event: string, ...args: unknown[]): void;
}

function makeFakeWebContents(): FakeWebContents {
  const handlers: Map<string, EventHandler[]> = new Map();
  const loadURLCalls: string[] = [];

  const wc: FakeWebContents = {
    _handlers: handlers,
    _windowOpenHandler: null,
    _loadURLCalls: loadURLCalls,

    on(event: string, handler: EventHandler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },

    setWindowOpenHandler(
      handler: (details: { url: string }) => {
        action: string;
        overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown> };
      },
    ) {
      this._windowOpenHandler = handler;
    },

    isDestroyed() {
      return false;
    },

    loadURL(url: string): Promise<void> {
      loadURLCalls.push(url);
      return Promise.resolve();
    },

    navigationHistory: {
      canGoBack() {
        return false;
      },
      canGoForward() {
        return false;
      },
    },

    emit(event: string, ...args: unknown[]) {
      const hs = handlers.get(event) ?? [];
      for (const h of hs) h(...args);
    },
  };

  return wc;
}

interface FakeSession {
  _permHandler: ((wc: unknown, perm: string, cb: (ok: boolean) => void) => void) | null;
  setPermissionRequestHandler(
    handler: (wc: unknown, perm: string, cb: (ok: boolean) => void) => void,
  ): void;
}

function makeFakeSession(): FakeSession {
  return {
    _permHandler: null,
    setPermissionRequestHandler(handler) {
      this._permHandler = handler;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. buildBrowserTabWebPreferences
// ---------------------------------------------------------------------------

describe("buildBrowserTabWebPreferences", () => {
  test("returns hardened webPreferences with the given partition", () => {
    const prefs = buildBrowserTabWebPreferences("persist:browser-ws-1");
    expect(prefs.partition).toBe("persist:browser-ws-1");
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    // No preload should be injected into browser tabs.
    expect(prefs.preload).toBeUndefined();
  });

  test("accepts different partition strings", () => {
    const prefs = buildBrowserTabWebPreferences("persist:browser-ws-abc");
    expect(prefs.partition).toBe("persist:browser-ws-abc");
  });
});

// ---------------------------------------------------------------------------
// 2. installPermissionHandler — permission matrix
// ---------------------------------------------------------------------------

describe("installPermissionHandler", () => {
  test("allows clipboard-sanitized-write", () => {
    const session = makeFakeSession();
    installPermissionHandler(session as unknown as import("electron").Session);
    expect(session._permHandler).not.toBeNull();

    let result: boolean | null = null;
    session._permHandler!(null, "clipboard-sanitized-write", (ok) => {
      result = ok;
    });
    expect(result).toBe(true);
  });

  const deniedPermissions = [
    "media",
    "geolocation",
    "notifications",
    "midi",
    "midiSysex",
    "pointerLock",
    "fullscreen",
    "openExternal",
    "clipboard-read",
    "display-capture",
  ];

  for (const perm of deniedPermissions) {
    test(`denies ${perm}`, () => {
      const session = makeFakeSession();
      installPermissionHandler(session as unknown as import("electron").Session);

      let result: boolean | null = null;
      session._permHandler!(null, perm, (ok) => {
        result = ok;
      });
      expect(result).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. installNavigationGuards — will-navigate
// ---------------------------------------------------------------------------

describe("installNavigationGuards — will-navigate", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    installNavigationGuards(wc as unknown as import("electron").WebContents);
  });

  test("allows http:// navigation", () => {
    const ev = makeFakeEvent();
    // The will-navigate handler receives (event, url)
    wc.emit("will-navigate", ev, "http://example.com");
    expect(ev.prevented).toBe(false);
  });

  test("allows https:// navigation", () => {
    const ev = makeFakeEvent();
    wc.emit("will-navigate", ev, "https://example.com/path?q=1");
    expect(ev.prevented).toBe(false);
  });

  test("blocks javascript: navigation", () => {
    const ev = makeFakeEvent();
    wc.emit("will-navigate", ev, "javascript:alert(1)");
    expect(ev.prevented).toBe(true);
  });

  test("blocks data: navigation", () => {
    const ev = makeFakeEvent();
    wc.emit("will-navigate", ev, "data:text/html,<h1>xss</h1>");
    expect(ev.prevented).toBe(true);
  });

  test("permits file: navigation (user-opt-in local content)", () => {
    // file: is in the navigation allowlist so users can open local HTML
    // documents.  webSecurity + sandbox on the WebContents still constrain
    // cross-origin behaviour at runtime; this guard only ensures the scheme
    // is not blocked at the navigation layer.
    const ev = makeFakeEvent();
    wc.emit("will-navigate", ev, "file:///Users/x/notes.html");
    expect(ev.prevented).toBe(false);
  });

  test("blocks about: navigation (about:blank is not useful as top-level)", () => {
    const ev = makeFakeEvent();
    wc.emit("will-navigate", ev, "about:blank");
    expect(ev.prevented).toBe(true);
  });

  test("calls onNavigate callback for allowed URLs", () => {
    let navigatedTo: string | null = null;
    const wc2 = makeFakeWebContents();
    installNavigationGuards(wc2 as unknown as import("electron").WebContents, (url) => {
      navigatedTo = url;
    });

    const ev = makeFakeEvent();
    wc2.emit("will-navigate", ev, "https://example.com");
    expect(ev.prevented).toBe(false);
    expect(navigatedTo).toBe("https://example.com");
  });

  test("does NOT call onNavigate callback for blocked URLs", () => {
    let called = false;
    const wc2 = makeFakeWebContents();
    installNavigationGuards(wc2 as unknown as import("electron").WebContents, () => {
      called = true;
    });

    const ev = makeFakeEvent();
    wc2.emit("will-navigate", ev, "javascript:alert(1)");
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. installNavigationGuards — will-frame-navigate
// ---------------------------------------------------------------------------

describe("installNavigationGuards — will-frame-navigate", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    installNavigationGuards(wc as unknown as import("electron").WebContents);
  });

  function fireFrameNavigate(url: string, isMainFrame: boolean): FakeEvent {
    // will-frame-navigate emits a SINGLE consolidated event object that
    // carries url, isMainFrame, and preventDefault() together — NOT the
    // 2-arg (event, details) form that will-navigate uses. Mirror that shape.
    const details = Object.assign(makeFakeEvent(), { url, isMainFrame });
    const frameHandlers = wc._handlers.get("will-frame-navigate") ?? [];
    for (const h of frameHandlers) h(details);
    return details;
  }

  test("allows about:blank for sub-frame initialisation", () => {
    const ev = fireFrameNavigate("about:blank", false);
    expect(ev.prevented).toBe(false);
  });

  test("allows https:// in sub-frames", () => {
    const ev = fireFrameNavigate("https://embed.example.com", false);
    expect(ev.prevented).toBe(false);
  });

  test("allows data: in sub-frames (sub-frame-only scheme; opaque origin)", () => {
    // Sub-frame data: is used by legitimate sites and is constrained by
    // webSecurity + sandbox. It stays blocked at top-level (see will-navigate).
    const ev = fireFrameNavigate("data:text/html,<h1>preview</h1>", false);
    expect(ev.prevented).toBe(false);
  });

  test("allows blob: in sub-frames (sub-frame-only scheme)", () => {
    const ev = fireFrameNavigate("blob:https://example.com/uuid", false);
    expect(ev.prevented).toBe(false);
  });

  test("blocks javascript: in sub-frames (code execution, never allowed)", () => {
    const ev = fireFrameNavigate("javascript:void(0)", false);
    expect(ev.prevented).toBe(true);
  });

  test("allows Chromium's built-in PDF viewer sub-frame (Electron 41 inline PDF)", () => {
    // The PDF viewer renders the document in an out-of-process sub-frame at
    // chrome-extension://<pdf-viewer-id>/...  Blocking it leaves the viewer
    // toolbar visible over a blank page; the guard must let this origin load.
    const ev = fireFrameNavigate(
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/b0f3c59b-1673-4ef0-a69d-008a3a328639",
      false,
    );
    expect(ev.prevented).toBe(false);
  });

  test("still blocks a NON-PDF chrome-extension sub-frame", () => {
    const ev = fireFrameNavigate("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x", false);
    expect(ev.prevented).toBe(true);
  });

  test("skips guard for main-frame sub-frame events (covered by will-navigate)", () => {
    // isMainFrame=true → guard should skip processing (will-navigate covers it)
    const ev = fireFrameNavigate("data:text/html,evil", true);
    // For main frame events, we return early — so data: is NOT blocked here
    // (it will be blocked by will-navigate instead).
    expect(ev.prevented).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. installNavigationGuards — setWindowOpenHandler
// ---------------------------------------------------------------------------

describe("installNavigationGuards — setWindowOpenHandler", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    installNavigationGuards(wc as unknown as import("electron").WebContents);
  });

  test("allows http/https popups (action:'allow') so OAuth window handles work", () => {
    const result = wc._windowOpenHandler!({ url: "https://accounts.example.com/oauth" });
    expect(result.action).toBe("allow");
  });

  test("allows file: popups", () => {
    const result = wc._windowOpenHandler!({ url: "file:///tmp/local.html" });
    expect(result.action).toBe("allow");
  });

  test("denies non-navigable schemes (javascript:)", () => {
    const result = wc._windowOpenHandler!({ url: "javascript:alert(1)" });
    expect(result.action).toBe("deny");
  });

  test("denies data: popups", () => {
    // data:/blob: are sub-frame-only; a top-level popup to them is denied.
    const result = wc._windowOpenHandler!({ url: "data:text/html,<h1>x</h1>" });
    expect(result.action).toBe("deny");
  });

  test("hardens the allowed popup's webPreferences (sandbox, isolation, no node)", () => {
    const result = wc._windowOpenHandler!({ url: "https://example.com" });
    const prefs = result.overrideBrowserWindowOptions?.webPreferences ?? {};
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. installNavigationGuards — did-create-window recursively guards popups
// ---------------------------------------------------------------------------

describe("installNavigationGuards — did-create-window (popup hardening)", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    installNavigationGuards(wc as unknown as import("electron").WebContents);
  });

  test("installs the same guards on a popup's WebContents", () => {
    const child = makeFakeWebContents();
    // Emit the event the same way Electron would: (childWindow, details).
    wc.emit("did-create-window", { webContents: child });

    // The child must now carry its own window-open handler and navigation
    // listeners — i.e. installNavigationGuards ran on it.
    expect(child._windowOpenHandler).not.toBeNull();
    expect((child._handlers.get("will-navigate") ?? []).length).toBeGreaterThan(0);
    expect((child._handlers.get("will-frame-navigate") ?? []).length).toBeGreaterThan(0);
  });

  test("the popup recursively denies non-navigable window.open schemes", () => {
    const child = makeFakeWebContents();
    wc.emit("did-create-window", { webContents: child });
    const result = child._windowOpenHandler!({ url: "javascript:alert(1)" });
    expect(result.action).toBe("deny");
  });
});
