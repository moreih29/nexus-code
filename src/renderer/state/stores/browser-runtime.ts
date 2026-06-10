/**
 * useBrowserRuntimeStore — volatile (non-persisted) runtime state for embedded
 * browser tabs.
 *
 * STATE SHAPE
 * -----------
 * A Map<tabId, BrowserRuntimeState> that tracks the live navigation and
 * loading state for every active browser tab.  Entries are added when
 * `navigated` / `loadingChanged` / `titleUpdated` events arrive from main
 * and removed when the tab is destroyed (via `removeRuntime`).
 *
 * PERSISTENCE
 * -----------
 * Intentionally volatile — this store is NOT included in persistence.ts.
 * State resets on every app launch / reload.
 *
 * LIFECYCLE
 * ---------
 * - `setRuntime(tabId, partial)` — upsert (merge) an entry.
 * - `getRuntime(tabId)` — point-in-time read (not a hook).
 * - `removeRuntime(tabId)` — remove an entry when its tab is destroyed.
 *
 * IPC events feed this store via `initBrowserRuntimeSubscriptions()` (called
 * from bootstrap).
 */

import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserRuntimeState {
  currentUrl: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /**
   * Cached page snapshot (JPEG dataURL) painted as an absolute overlay over
   * the placeholder area while the native WebContentsView is hidden by a
   * suspendAll cycle.  `null` means no snapshot is active — the live view
   * is visible, or no snapshot was captured.
   */
  snapshot: string | null;
  /**
   * Whether DevTools is currently open and docked for this tab.
   *
   * Driven by the `browser.devtoolsToggled` IPC event so the renderer can
   * (a) show / hide its splitter region, (b) start / stop the
   * `setDevToolsBounds` ResizeObserver, (c) reflect an "active" style on
   * the toolbar toggle button.
   */
  devtoolsOpen: boolean;
  /**
   * 페이지가 advertise한 favicon URL. Chromium의 page-favicon-updated 이벤트에서
   * 받은 후보 배열의 첫 번째 entry. 비어있으면 기본 아이콘(Globe)이 표시된다.
   * runtime store에만 보관 — 앱 재시작 시 페이지가 다시 로드되며 자연스럽게 갱신.
   */
  faviconUrl: string | null;
  /**
   * Imperative URL-bar focus trigger. Incremented by `requestUrlFocus`
   * (fired by the `browser.focusUrl` command, ⌘L); BrowserTabView passes
   * it to UrlBar's `focusToken` prop, which focuses + selects-all on
   * every change. Monotonic counter — the value itself is meaningless.
   */
  urlFocusToken: number;
}

type BrowserRuntimeMap = Map<string, BrowserRuntimeState>;

const DEFAULT_RUNTIME: BrowserRuntimeState = {
  currentUrl: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  snapshot: null,
  devtoolsOpen: false,
  faviconUrl: null,
  urlFocusToken: 0,
};

interface BrowserRuntimeStore {
  runtimes: BrowserRuntimeMap;

  /**
   * Upsert (merge) the partial runtime state for `tabId`.
   * Creates an entry with defaults if none exists.
   */
  setRuntime(tabId: string, partial: Partial<BrowserRuntimeState>): void;

  /**
   * Remove the runtime entry for `tabId`.
   * No-op if the entry does not exist.
   */
  removeRuntime(tabId: string): void;

  /**
   * Bump the URL-bar focus token for `tabId` so the mounted
   * BrowserTabView focuses + selects the URL bar. Creates the runtime
   * entry if it does not exist yet (harmless — the view merges state).
   */
  requestUrlFocus(tabId: string): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useBrowserRuntimeStore = create<BrowserRuntimeStore>((set, get) => ({
  runtimes: new Map(),

  setRuntime(tabId, partial) {
    set((state) => {
      const existing = state.runtimes.get(tabId) ?? { ...DEFAULT_RUNTIME };
      const next = new Map(state.runtimes);
      next.set(tabId, { ...existing, ...partial });
      return { runtimes: next };
    });
  },

  removeRuntime(tabId) {
    const { runtimes } = get();
    if (!runtimes.has(tabId)) return;
    set((state) => {
      const next = new Map(state.runtimes);
      next.delete(tabId);
      return { runtimes: next };
    });
  },

  requestUrlFocus(tabId) {
    const current = get().runtimes.get(tabId)?.urlFocusToken ?? 0;
    get().setRuntime(tabId, { urlFocusToken: current + 1 });
  },
}));

// ---------------------------------------------------------------------------
// Point-in-time accessor (non-reactive)
// ---------------------------------------------------------------------------

/**
 * Returns the current runtime state for `tabId`, or `undefined` if not found.
 * Non-reactive — suitable for imperative code paths (not React components).
 * React components should use `useBrowserRuntimeStore` with a selector.
 */
export function getRuntime(tabId: string): BrowserRuntimeState | undefined {
  return useBrowserRuntimeStore.getState().runtimes.get(tabId);
}
