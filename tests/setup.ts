// Global test setup — preloaded by bunfig.toml.
//
// Purpose:
// 1. Enable React's act() environment so RTL render calls do not flood stdout
//    with "current testing environment is not configured to support act(...)".
// 2. Filter out the React useSyncExternalStore "result of getSnapshot should be
//    cached" warning. Our slot-registry returns reference-stable values (HTMLElement
//    or null) per (workspaceId, leafId) key, so the warning is a false positive
//    triggered by RTL re-render churn under happy-dom. Suppressing it locally
//    keeps test output readable; production code is unaffected.
// 3. Stub @xterm/* leaf modules. The real xterm Terminal / addons need a live
//    browser rendering context; under happy-dom they activate without one and
//    then throw asynchronously ("Unhandled error between tests": TypeError
//    evaluating 'a.indexOf'), which bun attributes to whichever unrelated test
//    runs next. All three addons and the core Terminal are leaf third-party
//    modules, so stubbing them uniformly here removes the flake without touching
//    production code. Tests that inject their own createTerminal dep are unaffected.
// 4. Stub window.matchMedia. happy-dom provides window but not matchMedia.
//    The theme store (src/renderer/state/stores/theme.ts) calls
//    window.matchMedia("(prefers-color-scheme: dark)") at module-init time, so
//    any test file that transitively imports the theme store crashes if matchMedia
//    is absent. Adding it globally here is the correct single-point fix.

import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// @xterm/xterm — stub the Terminal class so the real xterm renderer never runs
// under happy-dom. The fake covers every method on the TerminalLike interface
// (controller.ts lines 21-31) plus every other call site found in source.
// ---------------------------------------------------------------------------
const disposable = { dispose(): void {} };

mock.module("@xterm/xterm", () => ({
  Terminal: class Terminal {
    readonly element: HTMLElement | undefined = undefined;
    readonly rows: number = 24;
    readonly parser = {
      registerOscHandler(
        _ident: number,
        _cb: (data: string) => boolean | Promise<boolean>,
      ): typeof disposable {
        return disposable;
      },
    };
    options: { theme: unknown } = { theme: undefined };

    dispose(): void {}
    loadAddon(_addon: unknown): void {}
    onData(_callback: (data: string) => void): typeof disposable { return disposable; }
    onResize(_callback: (size: { cols: number; rows: number }) => void): typeof disposable { return disposable; }
    onTitleChange(_callback: (title: string) => void): typeof disposable { return disposable; }
    onSelectionChange(_callback: () => void): typeof disposable { return disposable; }
    getSelection(): string { return ""; }
    open(_parent: HTMLElement): void {}
    refresh(_start: number, _end: number): void {}
    write(_data: string): void {}
    focus(): void {}
    blur(): void {}
    clear(): void {}
    reset(): void {}
    resize(_cols: number, _rows: number): void {}
    scrollToBottom(): void {}
    attachCustomKeyEventHandler(_handler: (event: KeyboardEvent) => boolean): void {}
  },
}));

// ---------------------------------------------------------------------------
// @xterm/addon-webgl — needs a live WebGL context; stub it out entirely.
// ---------------------------------------------------------------------------
mock.module("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    activate(): void {}
    dispose(): void {}
    onContextLoss(_callback: () => void): void {}
  },
}));

// ---------------------------------------------------------------------------
// @xterm/addon-canvas — same category as webgl; no canvas API under happy-dom.
// ---------------------------------------------------------------------------
mock.module("@xterm/addon-canvas", () => ({
  CanvasAddon: class CanvasAddon {
    activate(): void {}
    dispose(): void {}
  },
}));

// ---------------------------------------------------------------------------
// @xterm/addon-fit — uses DOM measurement APIs absent under happy-dom.
// ---------------------------------------------------------------------------
mock.module("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } | undefined { return undefined; }
  },
}));

// ---------------------------------------------------------------------------
// window.matchMedia — happy-dom provides window but not matchMedia.
// The theme store reads matchMedia at module-init time, so every test that
// transitively imports it would crash without this stub.
//
// Several test files replace globalThis.window with a plain IPC-stub object;
// when those files run before a file that imports the theme store for the
// first time, window.matchMedia is missing.  We intercept window assignments
// via a setter so matchMedia is always injected into any replacement window.
//
// Implementation note: setup.ts (preload) runs before happy-dom initialises
// window, so `window` is undefined at preload time.  We must preserve the
// original getter so that the real happy-dom window is still accessible after
// we wrap the accessor.  Additionally, we inject matchMedia lazily via the
// getter so it is available on the initial happy-dom window as well.
// ---------------------------------------------------------------------------

function makeMatchMediaStub() {
  return (_query: string): MediaQueryList => ({
    matches: false,
    media: _query,
    onchange: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    dispatchEvent(): boolean { return false; },
  } as MediaQueryList);
}

function ensureMatchMedia(win: unknown): void {
  if (
    win !== null &&
    win !== undefined &&
    typeof win === "object" &&
    typeof (win as Record<string, unknown>).matchMedia === "undefined"
  ) {
    Object.defineProperty(win as object, "matchMedia", {
      writable: true,
      configurable: true,
      value: makeMatchMediaStub(),
    });
  }
}

// Install a window getter/setter that:
//  • Forwards reads to the ORIGINAL getter (preserves happy-dom's window).
//  • On writes (test files replacing globalThis.window), ensures matchMedia
//    is available on the new window object.
//
// The accessor is intentionally non-configurable so that `delete globalThis.window`
// in test cleanup code does not silently remove it.  Test files that previously
// deleted globalThis.window to "restore" the pre-test undefined state should
// instead assign `undefined` via the setter — the getter returns the same
// `undefined` result, satisfying the intent of the cleanup.
(function patchWindowAccessor() {
  const existing = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalGet = existing?.get;

  // If there's already a getter, wrap it; otherwise capture the current value.
  let _override: unknown = null;
  let _hasOverride = false;

  Object.defineProperty(globalThis, "window", {
    configurable: false, // Prevent delete from removing the accessor.
    enumerable: true,
    get(): unknown {
      if (_hasOverride) return _override;
      // Delegate to the original getter (which returns happy-dom's window).
      const win = originalGet ? originalGet.call(globalThis) : undefined;
      // Lazily inject matchMedia into the happy-dom window.
      ensureMatchMedia(win);
      return win;
    },
    set(value: unknown) {
      // Tests that replace globalThis.window with a partial IPC stub
      // (e.g. {ipc: {...}}) inadvertently strip the happy-dom DOM APIs
      // (addEventListener, removeEventListener, etc.). Subsequent test
      // files that render React components calling window.addEventListener
      // then TypeError.
      //
      // Inject minimum DOM API stubs into the override so global hotkey
      // listeners and similar don't crash. Tests that need real DOM should
      // not override window at all (rely on happy-dom).
      if (value !== null && typeof value === "object") {
        const v = value as Record<string, unknown>;
        if (typeof v.addEventListener !== "function") {
          v.addEventListener = () => {};
        }
        if (typeof v.removeEventListener !== "function") {
          v.removeEventListener = () => {};
        }
        if (typeof v.dispatchEvent !== "function") {
          v.dispatchEvent = () => true;
        }
      }
      _override = value;
      _hasOverride = true;
      ensureMatchMedia(value);
    },
  });
})();

// happy-dom 가 MutationObserver 를 제공하지 않으므로 no-op stub. browser-suspend-auto
// 가 bootstrap 시 document.body 의 MutationObserver 를 설치하는데, 옵저버가 자동
// 실행되는지 자체는 본 test scope 밖이라 no-op 으로 충분.
(globalThis as Record<string, unknown>).MutationObserver ??=
  class MutationObserver {
    constructor(_cb: unknown) {}
    observe(_target: unknown, _options?: unknown): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string") {
    if (first.includes("not configured to support act")) return;
    if (first.includes("should be wrapped into act")) return;
    if (first.includes("getSnapshot should be cached")) return;
  }
  originalError(...args);
};
