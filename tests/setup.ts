// Global test setup — preloaded by bunfig.toml.
//
// Purpose:
// 1. Enable React's act() environment so RTL render calls do not flood stdout
//    with "current testing environment is not configured to support act(...)".

// ---------------------------------------------------------------------------
// i18next — initialise the singleton with English translations so any module
// that calls i18next.t() or useTranslation() at invocation time receives real
// strings instead of the key itself (or undefined on an uninitialised instance).
// The files.json namespace is loaded here as it is used by the files components
// under test. init() resolves instantly because all resources are bundled.
// ---------------------------------------------------------------------------
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { createI18n } from "../src/shared/i18n/index";
{
  const { options } = createI18n({ lng: "en" });
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init(options);
  }
}
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
      registerCsiHandler(
        _id: { prefix?: string; intermediates?: string; final: string },
        _cb: (params: ReadonlyArray<number | number[]>) => boolean,
      ): typeof disposable {
        return disposable;
      },
    };
    options: { theme: unknown } = { theme: undefined };
    readonly buffer = { active: { type: "normal" as "normal" | "alternate" } };

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
// @xterm/addon-ligatures — the real module is heavy (~200KB) and probes
// `navigator.fonts`; stub it so terminal tests stay light and deterministic.
// ---------------------------------------------------------------------------
mock.module("@xterm/addon-ligatures", () => ({
  LigaturesAddon: class LigaturesAddon {
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

// ---------------------------------------------------------------------------
// file-icon.tsx stub — this module uses Vite-specific APIs (import.meta.glob
// and *.svg?react imports) that are unavailable under Bun's test runner.
// We stub the entire module with a minimal implementation so that any test
// file that transitively imports row.tsx / tab-item.tsx / result-file-row.tsx
// / tree-row.tsx (all of which now use FileIcon) doesn't crash at module eval.
//
// The stub FileIcon renders a real Lucide icon using resolveLucide from the
// pure resolver module (file-icon-resolvers.ts) — preserving the className /
// tone / size behaviour tested by existing component tests.
//
// Tests that specifically verify FileIcon + Material theme behaviour import
// file-icon-resolvers.ts directly (pure, no Vite deps) and do not need this stub.
// ---------------------------------------------------------------------------
// The module path must match what the consuming files (row.tsx, tab-item.tsx, etc.)
// resolve to. Bun normalises relative imports to absolute paths so using the
// absolute path here works regardless of which file triggers the load.
// import.meta.dir is the directory of this setup.ts file (tests/).
const FILE_ICON_MODULE_PATH = `${import.meta.dir}/../src/renderer/components/files/file-tree/file-icon.tsx`;
const FILE_ICON_RESOLVERS_PATH = `${import.meta.dir}/../src/renderer/components/files/file-tree/file-icon-resolvers`;

mock.module(FILE_ICON_MODULE_PATH, () => {
    const React = require("react");
    // biome-ignore lint/nursery/noCommonJs: require needed in mock factory (no top-level await)
    const { resolveLucide } = require(FILE_ICON_RESOLVERS_PATH);

    const SIZE_CLASS: Record<string, string> = { sm: "size-3", md: "size-3.5" };
    const TONE_CLASS: Record<string, string> = {
      sidebar: "text-[var(--sidebar-icon-fg)]",
      muted: "text-muted-foreground",
    };

    function FileIcon({
      kind,
      name,
      size = "sm",
      tone,
      className,
      "aria-hidden": ariaHidden,
    }: {
      kind: string;
      name?: string;
      size?: string;
      tone: string;
      className?: string;
      "aria-hidden"?: boolean | "true" | "false";
    }) {
      const LucideComp = resolveLucide(kind, name);
      return React.createElement(LucideComp, {
        "aria-hidden": ariaHidden,
        className: [SIZE_CLASS[size], TONE_CLASS[tone], className].filter(Boolean).join(" "),
        strokeWidth: 1.5,
      });
    }

    return { FileIcon, resolveLucide, resolveMaterialIconName: () => null };
  },
);

// ---------------------------------------------------------------------------
// electron — canonical hermetic stub
//
// Electron is a native host module that is never available under bun:test.
// Tests that import main-process modules (ipc-router, pty/ipc, lsp/ipc, …)
// indirectly require electron through lazy `require("electron")` calls inside
// function bodies (setupRouter, broadcast, initMainLogger, etc.).
//
// Without this stub the first test file to trigger such a require receives
// bun's native electron shim, which may be incomplete (e.g. missing ipcMain
// or webContents).  Subsequent files that register their own mock.module call
// may or may not win the race depending on bun's internal evaluation order.
//
// Registering a complete, no-op stub here in the preload ensures that:
//   1. Every test file starts from a consistent baseline.
//   2. Files that need spy mocks (pty-channel, ipc-shim-integration, …) can
//      override individual exports via their own mock.module — bun honours the
//      last registration that arrives before the first require() of the module.
//   3. Files that only need webContents.getAllWebContents (lsp-channel, …)
//      do not need their own mock.module at all.
//
// Surface decisions — derived by grepping every tests/unit/main/**/*.test.ts
// for `mock.module("electron")` and collecting all top-level keys and nested
// method names used across those files.
// ---------------------------------------------------------------------------
mock.module("electron", () => ({
  // app — used by: get-agent-bin-dir, workspace/*, error-safety-net,
  //               pty-channel, ipc-shim-integration, ipc-wrapper-env,
  //               claude/hook-handler, show-save-dialog
  app: {
    isPackaged: false,
    getPath: (_name: string): string => "/tmp/nexus-test",
    getVersion: (): string => "0.0.0-test",
    getName: (): string => "nexus-test",
    getLocale: (): string => "en",
    quit: (): void => {},
  },

  // ipcMain — used by: setupRouter() in pty-channel, ipc-shim-integration,
  //                    ipc-wrapper-env, show-save-dialog
  ipcMain: {
    on: (_channel: string, _listener: unknown): void => {},
    handle: (_channel: string, _listener: unknown): void => {},
    removeHandler: (_channel: string): void => {},
    removeAllListeners: (_channel?: string): void => {},
    emit: (_channel: string, ..._args: unknown[]): boolean => false,
  },

  // ipcRenderer — used by renderer-side code that is loaded in some main tests
  ipcRenderer: {
    invoke: async (_channel: string, ..._args: unknown[]): Promise<unknown> => null,
    on: (_channel: string, _listener: unknown): void => {},
    send: (_channel: string, ..._args: unknown[]): void => {},
    removeListener: (_channel: string, _listener: unknown): void => {},
  },

  // webContents — used by broadcast() in ipc-router, lsp-channel, pty-channel
  webContents: {
    getAllWebContents: (): Array<{ isDestroyed(): boolean; send(..._args: unknown[]): void }> => [],
  },

  // BrowserWindow — used by claude/hook-handler
  BrowserWindow: {
    getFocusedWindow: (): null => null,
    getAllWindows: (): unknown[] => [],
  },

  // Notification — used by claude/hook-handler
  Notification: class Notification {
    title = "";
    body = "";
    constructor(_opts?: { title?: string; body?: string }) {
      this.title = _opts?.title ?? "";
      this.body = _opts?.body ?? "";
    }
    on(_event: string, _cb: () => void): this { return this; }
    show(): void {}
  },

  // protocol — used by custom-protocols/nexus-workspace-ssh
  protocol: {
    registerSchemesAsPrivileged: (_schemes: unknown[]): void => {},
    handle: (_scheme: string, _handler: unknown): void => {},
  },

  // net — used by custom-protocols/nexus-workspace-ssh
  net: {
    fetch: async (_url: string, _options?: unknown): Promise<Response> =>
      new Response(null, { status: 500 }),
  },

  // dialog — used by features/dialog/show-save-dialog
  dialog: {
    showSaveDialog: async (
      _window: unknown,
      _options?: unknown,
    ): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true }),
    showOpenDialog: async (
      _window: unknown,
      _options?: unknown,
    ): Promise<{ canceled: boolean; filePaths: string[] }> => ({
      canceled: true,
      filePaths: [],
    }),
  },

  // WebContentsView — used by features/browser/evaluate-permission, security
  WebContentsView: class WebContentsView {},
}));

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
