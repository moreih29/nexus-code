import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { createI18n } from "../src/shared/i18n/index";

{
  const { options } = createI18n({ lng: "en" });
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init(options);
  }
}

import { mock } from "bun:test";

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
      registerEscHandler(
        _id: { intermediates?: string; final: string },
        _cb: () => boolean,
      ): typeof disposable {
        return disposable;
      },
    };
    options: { theme: unknown } = { theme: undefined };
    readonly buffer = { active: { type: "normal" as "normal" | "alternate" } };

    dispose(): void {}
    loadAddon(_addon: unknown): void {}
    onData(_callback: (data: string) => void): typeof disposable {
      return disposable;
    }
    onResize(_callback: (size: { cols: number; rows: number }) => void): typeof disposable {
      return disposable;
    }
    onTitleChange(_callback: (title: string) => void): typeof disposable {
      return disposable;
    }
    onSelectionChange(_callback: () => void): typeof disposable {
      return disposable;
    }
    getSelection(): string {
      return "";
    }
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

mock.module("@xterm/addon-ligatures", () => ({
  LigaturesAddon: class LigaturesAddon {
    activate(): void {}
    dispose(): void {}
  },
}));

mock.module("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } | undefined {
      return undefined;
    }
  },
}));

function makeMatchMediaStub() {
  return (_query: string): MediaQueryList =>
    ({
      matches: false,
      media: _query,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent(): boolean {
        return false;
      },
    }) as MediaQueryList;
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

(function patchWindowAccessor() {
  const existing = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalGet = existing?.get;

  let _override: unknown = null;
  let _hasOverride = false;

  Object.defineProperty(globalThis, "window", {
    configurable: false,
    enumerable: true,
    get(): unknown {
      if (_hasOverride) return _override;
      const win = originalGet ? originalGet.call(globalThis) : undefined;
      ensureMatchMedia(win);
      return win;
    },
    set(value: unknown) {
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

(globalThis as Record<string, unknown>).MutationObserver ??= class MutationObserver {
  constructor(_cb: unknown) {}
  observe(_target: unknown, _options?: unknown): void {}
  disconnect(): void {}
  takeRecords(): unknown[] {
    return [];
  }
};

const FILE_ICON_MODULE_PATH = `${import.meta.dir}/../src/renderer/components/files/file-tree/file-icon.tsx`;
const FILE_ICON_RESOLVERS_PATH = `${import.meta.dir}/../src/renderer/components/files/file-tree/file-icon-resolvers`;

mock.module(FILE_ICON_MODULE_PATH, () => {
  const React = require("react");
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
});

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getPath: (_name: string): string => "/tmp/nexus-test",
    getVersion: (): string => "0.0.0-test",
    getName: (): string => "nexus-test",
    getLocale: (): string => "en",
    quit: (): void => {},
  },

  nativeImage: {},
  shell: {},
  systemPreferences: {},
  safeStorage: {},

  ipcMain: {
    on: (_channel: string, _listener: unknown): void => {},
    handle: (_channel: string, _listener: unknown): void => {},
    removeHandler: (_channel: string): void => {},
    removeAllListeners: (_channel?: string): void => {},
    emit: (_channel: string, ..._args: unknown[]): boolean => false,
  },

  ipcRenderer: {
    invoke: async (_channel: string, ..._args: unknown[]): Promise<unknown> => null,
    on: (_channel: string, _listener: unknown): void => {},
    send: (_channel: string, ..._args: unknown[]): void => {},
    removeListener: (_channel: string, _listener: unknown): void => {},
  },

  webContents: {
    getAllWebContents: (): Array<{ isDestroyed(): boolean; send(..._args: unknown[]): void }> => [],
  },

  BrowserWindow: {
    getFocusedWindow: (): null => null,
    getAllWindows: (): unknown[] => [],
  },

  BaseWindow: class BaseWindow {},
  screen: {},

  Menu: {
    getApplicationMenu: (): null => null,
  },

  Notification: class Notification {
    title = "";
    body = "";
    constructor(_opts?: { title?: string; body?: string }) {
      this.title = _opts?.title ?? "";
      this.body = _opts?.body ?? "";
    }
    on(_event: string, _cb: () => void): this {
      return this;
    }
    show(): void {}
  },

  protocol: {
    registerSchemesAsPrivileged: (_schemes: unknown[]): void => {},
    handle: (_scheme: string, _handler: unknown): void => {},
  },

  net: {
    fetch: async (_url: string, _options?: unknown): Promise<Response> =>
      new Response(null, { status: 500 }),
  },

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

  WebContentsView: class WebContentsView {},

  session: {
    fromPartition: (_partition: string) => ({
      clearStorageData: async (): Promise<void> => {},
    }),
  },
}));

await import("electron");

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
