/**
 * Unit tests for registerBrowserChannel — WebContents event → broadcast wiring.
 *
 * Tests cover:
 *  1. did-navigate fires broadcast("browser", "navigated", { tabId, url, canGoBack, canGoForward })
 *  2. did-navigate-in-page fires broadcast("browser", "navigated", ...)
 *  3. did-start-loading fires broadcast("browser", "loadingChanged", { tabId, isLoading: true })
 *  4. did-stop-loading fires broadcast("browser", "loadingChanged", { tabId, isLoading: false })
 *  5. did-fail-load fires broadcast("browser", "error", ...) AND broadcast("browser", "loadingChanged", { isLoading: false })
 *  6. page-title-updated fires broadcast("browser", "titleUpdated", { tabId, title })
 *
 * All Electron APIs are mocked.  The `broadcast` helper is mocked via the
 * ipc-router module so we can assert the exact channel/event/payload sent.
 *
 * DESIGN NOTE: `register` is mocked to capture the `create` call handler so
 * we can invoke it directly in tests — this exercises the event wiring code
 * in `registerBrowserChannel` without needing a real IPC router.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BroadcastCall {
  channel: string;
  event: string;
  args: unknown;
}

type CallHandler = (args: unknown) => unknown;

interface ChannelDef {
  call: Record<string, CallHandler>;
  listen?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Captured state
// ---------------------------------------------------------------------------

const broadcastCalls: BroadcastCall[] = [];

// Capture the channel def registered by registerBrowserChannel so tests can
// invoke the `create` call handler directly.
let capturedChannelDef: ChannelDef | null = null;

// ---------------------------------------------------------------------------
// Mock: ipc-router
// ---------------------------------------------------------------------------

mock.module("../../../../../src/main/infra/ipc-router", () => ({
  broadcast: (channel: string, event: string, args: unknown) => {
    broadcastCalls.push({ channel, event, args });
  },
  register: (_name: string, def: ChannelDef) => {
    capturedChannelDef = def;
  },
  validateArgs: <T>(_schema: unknown, args: T): T => args,
}));

// ---------------------------------------------------------------------------
// Mock: shared/ipc/result
// ---------------------------------------------------------------------------

mock.module("../../../../../src/shared/ipc/result", () => ({
  ipcOk: (value: unknown) => ({ ok: true, value }),
}));

// ---------------------------------------------------------------------------
// Mock: security (no-op stubs)
// ---------------------------------------------------------------------------

mock.module("../../../../../src/main/features/browser/security", () => ({
  buildBrowserTabWebPreferences: () => ({}),
  installPermissionHandler: () => {},
  installNavigationGuards: () => {},
}));

// ---------------------------------------------------------------------------
// Mock: shared/log/main
// ---------------------------------------------------------------------------

mock.module("../../../../../src/shared/log/main", () => ({
  createLogger: () => ({
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Electron mock — FakeWebContents with emit() helper
// ---------------------------------------------------------------------------

type EventHandler = (...args: unknown[]) => void;

class FakeWebContents {
  handlers: Record<string, EventHandler[]> = {};
  backgroundThrottling: boolean | null = null;
  destroyed = false;
  session = { setPermissionRequestHandler: () => {} };
  navigationHistory = {
    _back: false,
    _fwd: false,
    canGoBack() { return this._back; },
    canGoForward() { return this._fwd; },
  };

  on(event: string, handler: EventHandler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  setBackgroundThrottling(val: boolean) { this.backgroundThrottling = val; }
  isDestroyed() { return this.destroyed; }
  isLoading() { return false; }
  insertCSS(_css: string) { return Promise.resolve("k"); }
  setWindowOpenHandler() {}
  loadURL(_url: string) { return Promise.resolve(); }

  /** Trigger all registered handlers for the given event. */
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) {
      handler(...args);
    }
  }
}

class FakeWebContentsView {
  webContents = new FakeWebContents();
  constructor(public opts: unknown) {}
  setBounds() {}
}

class FakeContentView {
  addChildView() {}
  removeChildView() {}
}

class FakeBrowserWindow {
  contentView = new FakeContentView();
}

mock.module("electron", () => ({
  WebContentsView: FakeWebContentsView,
  BrowserWindow: FakeBrowserWindow,
}));

// ---------------------------------------------------------------------------
// Lazy imports (after all mocks registered)
// ---------------------------------------------------------------------------

const { BrowserTabRegistry } = await import(
  "../../../../../src/main/features/browser/registry"
);
const { registerBrowserChannel } = await import(
  "../../../../../src/main/features/browser/ipc"
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAB_ID = "11111111-0000-0000-0000-000000000001";
const WS_ID = "22222222-0000-0000-0000-000000000001";
const URL = "https://example.com";
const PARTITION = `persist:browser-${WS_ID}`;

// ---------------------------------------------------------------------------
// Helper — set up registry + channel + trigger create IPC handler
// ---------------------------------------------------------------------------

function makeSetup(): { wc: FakeWebContents } {
  capturedChannelDef = null;
  broadcastCalls.length = 0;

  const win = new FakeBrowserWindow();
  const registry = new BrowserTabRegistry(win as unknown as import("electron").BrowserWindow);
  registerBrowserChannel(registry);

  // The `registerBrowserChannel` call invokes `register("browser", { call: { create, ... } })`.
  // Our mock captures the def.  Now invoke the `create` handler to wire the WebContents
  // event listeners — this mirrors what the real IPC router does on `browser.create` calls.
  if (!capturedChannelDef) throw new Error("register() was not called by registerBrowserChannel");

  capturedChannelDef.call["create"]({
    tabId: TAB_ID,
    workspaceId: WS_ID,
    url: URL,
    partition: PARTITION,
  });

  const entry = registry.get(TAB_ID)!;
  const wc = entry.view.webContents as unknown as FakeWebContents;
  return { wc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerBrowserChannel — WebContents event → broadcast", () => {
  beforeEach(() => {
    broadcastCalls.length = 0;
  });

  // -------------------------------------------------------------------------
  // 1. did-navigate
  // -------------------------------------------------------------------------

  test("did-navigate fires browser:navigated with url, canGoBack, canGoForward", () => {
    const { wc } = makeSetup();
    wc.navigationHistory._back = true;
    wc.navigationHistory._fwd = false;

    wc.emit("did-navigate", {}, "https://example.com/page", 200, "OK");

    const call = broadcastCalls.find(
      (c) => c.channel === "browser" && c.event === "navigated",
    );
    expect(call).toBeDefined();
    expect(call!.args).toEqual({
      tabId: TAB_ID,
      url: "https://example.com/page",
      canGoBack: true,
      canGoForward: false,
    });
  });

  // -------------------------------------------------------------------------
  // 2. did-navigate-in-page
  // -------------------------------------------------------------------------

  test("did-navigate-in-page fires browser:navigated", () => {
    const { wc } = makeSetup();
    wc.navigationHistory._back = false;
    wc.navigationHistory._fwd = true;

    wc.emit("did-navigate-in-page", {}, "https://example.com/#anchor");

    const call = broadcastCalls.find(
      (c) => c.channel === "browser" && c.event === "navigated",
    );
    expect(call).toBeDefined();
    expect(call!.args).toEqual({
      tabId: TAB_ID,
      url: "https://example.com/#anchor",
      canGoBack: false,
      canGoForward: true,
    });
  });

  // -------------------------------------------------------------------------
  // 3. did-start-loading
  // -------------------------------------------------------------------------

  test("did-start-loading fires browser:loadingChanged with isLoading=true", () => {
    const { wc } = makeSetup();
    wc.emit("did-start-loading");

    const call = broadcastCalls.find(
      (c) => c.channel === "browser" && c.event === "loadingChanged",
    );
    expect(call).toBeDefined();
    expect(call!.args).toEqual({ tabId: TAB_ID, isLoading: true });
  });

  // -------------------------------------------------------------------------
  // 4. did-stop-loading
  // -------------------------------------------------------------------------

  test("did-stop-loading fires browser:loadingChanged with isLoading=false", () => {
    const { wc } = makeSetup();
    wc.emit("did-stop-loading");

    const call = broadcastCalls.find(
      (c) => c.channel === "browser" && c.event === "loadingChanged",
    );
    expect(call).toBeDefined();
    expect(call!.args).toEqual({ tabId: TAB_ID, isLoading: false });
  });

  // -------------------------------------------------------------------------
  // 5. did-fail-load — error AND loadingChanged=false
  // -------------------------------------------------------------------------

  test("did-fail-load fires browser:error broadcast", () => {
    const { wc } = makeSetup();
    wc.emit("did-fail-load", {}, -2, "ERR_FAILED", "https://example.com");

    const errorCall = broadcastCalls.find(
      (c) => c.channel === "browser" && c.event === "error",
    );
    expect(errorCall).toBeDefined();
    expect(errorCall!.args).toEqual({
      tabId: TAB_ID,
      code: -2,
      description: "ERR_FAILED",
      url: "https://example.com",
    });
  });

  test("did-fail-load also fires browser:loadingChanged with isLoading=false", () => {
    const { wc } = makeSetup();
    wc.emit("did-fail-load", {}, -2, "ERR_FAILED", "https://example.com");

    const loadingCall = broadcastCalls.find(
      (c) => c.channel === "browser" && c.event === "loadingChanged",
    );
    expect(loadingCall).toBeDefined();
    expect(loadingCall!.args).toEqual({ tabId: TAB_ID, isLoading: false });
  });

  // -------------------------------------------------------------------------
  // 6. page-title-updated
  // -------------------------------------------------------------------------

  test("page-title-updated fires browser:titleUpdated", () => {
    const { wc } = makeSetup();
    wc.emit("page-title-updated", {}, "My Page Title");

    const call = broadcastCalls.find(
      (c) => c.channel === "browser" && c.event === "titleUpdated",
    );
    expect(call).toBeDefined();
    expect(call!.args).toEqual({ tabId: TAB_ID, title: "My Page Title" });
  });
});
