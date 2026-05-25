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
}

type BrowserRuntimeMap = Map<string, BrowserRuntimeState>;

const DEFAULT_RUNTIME: BrowserRuntimeState = {
  currentUrl: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  snapshot: null,
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
