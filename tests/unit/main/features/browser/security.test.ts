import { beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mainWarnMock } from "../../../../log-test-spies";

mock.module("electron", () => ({
  WebContentsView: class {},
}));

const {
  buildBrowserTabWebPreferences,
  installPermissionHandler,
  installNavigationGuards,
  POPUP_ACTIVATION_MS,
} = await import("../../../../../src/main/features/browser/security");

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
  id: number;
  on(event: string, handler: EventHandler): void;
  once(event: string, handler: EventHandler): void;
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

let nextFakeWebContentsId = 1;

function makeFakeWebContents(): FakeWebContents {
  const handlers: Map<string, EventHandler[]> = new Map();
  const loadURLCalls: string[] = [];

  const wc: FakeWebContents = {
    id: nextFakeWebContentsId++,
    _handlers: handlers,
    _windowOpenHandler: null,
    _loadURLCalls: loadURLCalls,

    on(event: string, handler: EventHandler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },

    once(event: string, handler: EventHandler) {
      this.on(event, handler);
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

describe("buildBrowserTabWebPreferences", () => {
  test("returns hardened webPreferences with the given partition", () => {
    const prefs = buildBrowserTabWebPreferences("persist:browser-ws-1");
    expect(prefs.partition).toBe("persist:browser-ws-1");
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.preload).toBeUndefined();
  });
});

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

describe("installNavigationGuards — will-navigate", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    installNavigationGuards(wc as unknown as import("electron").WebContents);
  });

  test("allows http:// navigation", () => {
    const ev = makeFakeEvent();
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

describe("installNavigationGuards — will-frame-navigate", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    installNavigationGuards(wc as unknown as import("electron").WebContents);
  });

  function fireFrameNavigate(url: string, isMainFrame: boolean): FakeEvent {
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
    const ev = fireFrameNavigate("data:text/html,evil", true);
    expect(ev.prevented).toBe(false);
  });
});

describe("installNavigationGuards — setWindowOpenHandler", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    installNavigationGuards(wc as unknown as import("electron").WebContents);
  });

  const click = () => wc.emit("before-mouse-event", {}, { type: "mouseUp" });

  test("allows http/https popups (action:'allow') so OAuth window handles work", () => {
    click();
    const result = wc._windowOpenHandler!({ url: "https://accounts.example.com/oauth" });
    expect(result.action).toBe("allow");
  });

  test("opens a popup only after input in the page, one for each input", () => {
    expect(wc._windowOpenHandler!({ url: "https://example.com/timer" }).action).toBe("deny");
    click();
    expect(wc._windowOpenHandler!({ url: "https://example.com/a" }).action).toBe("allow");
    expect(wc._windowOpenHandler!({ url: "https://example.com/b" }).action).toBe("deny");
    wc.emit("before-input-event", {}, { type: "keyDown", key: "Enter" });
    expect(wc._windowOpenHandler!({ url: "https://example.com/c" }).action).toBe("allow");
    wc.emit("before-input-event", {}, { type: "keyDown", key: "a" });
    expect(wc._windowOpenHandler!({ url: "https://example.com/d" }).action).toBe("deny");
    click();
    expect(wc._windowOpenHandler!({ url: "javascript:alert(1)" }).action).toBe("deny");
    expect(wc._windowOpenHandler!({ url: "https://example.com/e" }).action).toBe("allow");
  });

  test("not once the input is POPUP_ACTIVATION_MS old", () => {
    const start = Date.now();
    try {
      setSystemTime(new Date(start));
      click();
      setSystemTime(new Date(start + POPUP_ACTIVATION_MS + 1));
      expect(wc._windowOpenHandler!({ url: "https://example.com/late" }).action).toBe("deny");
      click();
      setSystemTime(new Date(start + 2 * POPUP_ACTIVATION_MS));
      expect(wc._windowOpenHandler!({ url: "https://example.com/in-time" }).action).toBe("allow");
    } finally {
      setSystemTime();
    }
  });

  test("denies file: popups: the file:// page that opens one could read it", () => {
    const result = wc._windowOpenHandler!({ url: "file:///Users/x/.ssh/id_rsa" });
    expect(result.action).toBe("deny");
  });

  test("denies non-navigable schemes (javascript:)", () => {
    const result = wc._windowOpenHandler!({ url: "javascript:alert(1)" });
    expect(result.action).toBe("deny");
  });

  test("denies data: popups", () => {
    const result = wc._windowOpenHandler!({ url: "data:text/html,<h1>x</h1>" });
    expect(result.action).toBe("deny");
  });

  test("hardens the allowed popup's webPreferences (sandbox, isolation, no node)", () => {
    click();
    const result = wc._windowOpenHandler!({ url: "https://example.com" });
    const prefs = result.overrideBrowserWindowOptions?.webPreferences ?? {};
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).toBe(true);
  });
});

describe("installNavigationGuards — did-create-window (popup hardening)", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    installNavigationGuards(wc as unknown as import("electron").WebContents);
  });

  test("installs the same guards on a popup's WebContents", () => {
    const child = makeFakeWebContents();
    wc.emit("did-create-window", { webContents: child });

    expect(child._windowOpenHandler).not.toBeNull();
    expect((child._handlers.get("will-navigate") ?? []).length).toBeGreaterThan(0);
    expect((child._handlers.get("will-frame-navigate") ?? []).length).toBeGreaterThan(0);
  });

  test("a popup does not go to a local file, which its opener could read", () => {
    const child = makeFakeWebContents();
    wc.emit("did-create-window", { webContents: child });
    const toFile = makeFakeEvent();
    child.emit("will-navigate", toFile, "file:///Users/x/.ssh/id_rsa");
    expect(toFile.prevented).toBe(true);
    const toWeb = makeFakeEvent();
    child.emit("will-navigate", toWeb, "https://accounts.example.com/");
    expect(toWeb.prevented).toBe(false);
  });

  test("the popup recursively denies non-navigable window.open schemes", () => {
    const child = makeFakeWebContents();
    wc.emit("did-create-window", { webContents: child });
    const result = child._windowOpenHandler!({ url: "javascript:alert(1)" });
    expect(result.action).toBe("deny");
  });

  test("reports popups, and popups of popups, to onPopup", () => {
    const opener = makeFakeWebContents();
    const popups: unknown[] = [];
    installNavigationGuards(
      opener as unknown as import("electron").WebContents,
      undefined,
      (popup) => popups.push(popup),
    );
    const child = { webContents: makeFakeWebContents() };
    const grandchild = { webContents: makeFakeWebContents() };

    opener.emit("did-create-window", child);
    child.webContents.emit("did-create-window", grandchild);

    expect(popups).toEqual([child, grandchild]);
  });
});

test("blocked browser navigations omit URL payloads from diagnostics", () => {
  const view = makeFakeWebContents();
  installNavigationGuards(view as never);
  const event = makeFakeEvent();
  const logs = mainWarnMock.mock.calls.length;
  view.emit("will-navigate", event, "data:text/plain,private-navigation-token");

  expect(event.prevented).toBe(true);
  const warnings = mainWarnMock.mock.calls.slice(logs);
  expect(warnings).toHaveLength(1);
  expect(JSON.stringify(warnings)).not.toContain("private-navigation-token");
});
