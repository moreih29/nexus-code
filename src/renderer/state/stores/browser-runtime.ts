import { create } from "zustand";

export interface BrowserRuntimeState {
  currentUrl: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  loadFailure: { url: string; description: string } | null;
  snapshot: string | null;
  devtoolsOpen: boolean;
  faviconUrl: string | null;
  urlFocusToken: number;
}

type BrowserRuntimeMap = Map<string, BrowserRuntimeState>;

const DEFAULT_RUNTIME: BrowserRuntimeState = {
  currentUrl: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  loadFailure: null,
  snapshot: null,
  devtoolsOpen: false,
  faviconUrl: null,
  urlFocusToken: 0,
};

interface BrowserRuntimeStore {
  runtimes: BrowserRuntimeMap;

  setRuntime(tabId: string, partial: Partial<BrowserRuntimeState>): void;

  removeRuntime(tabId: string): void;

  requestUrlFocus(tabId: string): void;
}

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

export function getRuntime(tabId: string): BrowserRuntimeState | undefined {
  return useBrowserRuntimeStore.getState().runtimes.get(tabId);
}
