import { create } from "zustand";
import { STATE_PERSIST_DEBOUNCE_MS } from "../../../shared/timing-constants";
import type { ViewMode } from "../../../shared/types/panel";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../shared/types/panel";
import type {
  FileMatch,
  SearchComplete,
  SearchRange,
  TextSearchQuery,
} from "../../../shared/types/search";
import { ipcCall, ipcStream } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../lifecycle/workspace-cleanup";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SearchStatus = "idle" | "running" | "done" | "error";

export interface FileGroup {
  relPath: string;
  matches: { range: SearchRange; preview: string }[];
  expanded: boolean;
}

export type SearchOptions = Omit<TextSearchQuery, "pattern" | "maxResults" | "maxFileSize">;

export const EMPTY_SEARCH_OPTIONS: SearchOptions = {
  isRegExp: false,
  isCaseSensitive: false,
  isWordMatch: false,
  includes: [],
  excludes: [],
};

export interface SearchSession {
  query: string;
  options: SearchOptions;
  results: FileGroup[];
  status: SearchStatus;
  limitHit: boolean;
  filesScanned: number;
  matchesFound: number;
  elapsedMs: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Per-workspace view options (tree/list + compact) + expanded dir set
// ---------------------------------------------------------------------------

export interface SearchViewState {
  viewMode: ViewMode;
  compactFolders: boolean;
  /** Expanded directory paths in tree mode — session-scoped, not persisted. */
  expandedDirs: Set<string>;
}

interface SearchState {
  sessions: Map<string, SearchSession>;
  /** Per-workspace view options (loaded from storage + local expandedDirs). */
  viewStates: Map<string, SearchViewState>;
  startSearch: (workspaceId: string, query: string, options: SearchOptions) => void;
  cancelSearch: (workspaceId: string) => void;
  /**
   * Drop the entire search session — aborts any in-flight stream and removes
   * the workspace's session entry. Use this when the user clears the search
   * input (X button, Esc, or backspaced to empty); `cancelSearch` only flips
   * status to idle and keeps the existing results around.
   */
  clearSearch: (workspaceId: string) => void;
  toggleGroup: (workspaceId: string, relPath: string) => void;
  closeAllForWorkspace: (workspaceId: string) => void;
  /**
   * Load persisted view options (viewMode, compactFolders) for a workspace
   * from the panel IPC channel. Safe to call multiple times — skips if
   * already loaded.
   */
  loadViewOptions: (workspaceId: string) => void;
  /** Change viewMode and persist asynchronously. */
  setViewMode: (workspaceId: string, next: ViewMode) => void;
  /** Change compactFolders and persist asynchronously. */
  setCompactFolders: (workspaceId: string, next: boolean) => void;
  /** Toggle a directory's expanded state (session-scoped, not persisted). */
  toggleExpandedDir: (workspaceId: string, relPath: string) => void;
}

// ---------------------------------------------------------------------------
// Module-scoped AbortController map — lives outside zustand so abort() calls
// never trigger a state re-render.
// ---------------------------------------------------------------------------

const controllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Module-scoped debounce state for view-options persistence.
// ---------------------------------------------------------------------------

const viewOptionsSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function canUseIpcBridge(): boolean {
  return typeof window !== "undefined" && "ipc" in window;
}

const DEFAULT_SEARCH_VIEW: SearchViewState = {
  viewMode: DEFAULT_VIEW_OPTIONS_BY_PANEL.search.viewMode,
  compactFolders: DEFAULT_VIEW_OPTIONS_BY_PANEL.search.compactFolders,
  expandedDirs: new Set<string>(),
};

/**
 * Schedule a debounced persist of viewMode + compactFolders for a workspace.
 * Repeated calls within STATE_PERSIST_DEBOUNCE_MS reset the timer.
 */
function scheduleViewOptionsSave(
  workspaceId: string,
  viewMode: ViewMode,
  compactFolders: boolean,
): void {
  if (!canUseIpcBridge()) return;

  const existing = viewOptionsSaveTimers.get(workspaceId);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    viewOptionsSaveTimers.delete(workspaceId);
    ipcCall("panel", "setViewOptions", {
      workspaceId,
      panelKind: "search",
      viewMode,
      compactFolders,
    }).catch((error: unknown) => {
      console.error("[search] setViewOptions failed", error);
    });
  }, STATE_PERSIST_DEBOUNCE_MS);

  viewOptionsSaveTimers.set(workspaceId, handle);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSearchStore = create<SearchState>((set, get) => {
  registerWorkspaceCleanup((id) => {
    get().closeAllForWorkspace(id);
  });

  // ------------------------------------------------------------------
  // Internal helpers — closed over set/get.
  // ------------------------------------------------------------------

  function appendBatch(wsId: string, batch: FileMatch[]): void {
    const session = get().sessions.get(wsId);
    if (!session || session.status !== "running") return;

    const groupMap = new Map<string, FileGroup>(session.results.map((g) => [g.relPath, g]));

    let addedMatches = 0;
    for (const fm of batch) {
      const existing = groupMap.get(fm.relPath);
      if (existing) {
        groupMap.set(fm.relPath, { ...existing, matches: [...existing.matches, ...fm.matches] });
      } else {
        groupMap.set(fm.relPath, {
          relPath: fm.relPath,
          matches: [...fm.matches],
          expanded: true,
        });
      }
      addedMatches += fm.matches.length;
    }

    // Preserve insertion order: updated groups first, new ones appended.
    const nextResults = [...session.results.map((g) => groupMap.get(g.relPath) ?? g)];
    for (const fm of batch) {
      if (!session.results.some((g) => g.relPath === fm.relPath)) {
        const group = groupMap.get(fm.relPath);
        if (group) nextResults.push(group);
      }
    }

    set((state) => {
      const cur = state.sessions.get(wsId);
      if (!cur || cur.status !== "running") return state;
      const next = new Map(state.sessions);
      next.set(wsId, {
        ...cur,
        results: nextResults,
        matchesFound: cur.matchesFound + addedMatches,
      });
      return { sessions: next };
    });
  }

  function finishSearch(wsId: string, ctrl: AbortController, complete: SearchComplete): void {
    if (controllers.get(wsId) !== ctrl) return;

    controllers.delete(wsId);

    set((state) => {
      const cur = state.sessions.get(wsId);
      if (!cur) return state;
      const next = new Map(state.sessions);
      next.set(wsId, {
        ...cur,
        status: "done",
        limitHit: complete.limitHit,
        filesScanned: complete.filesScanned,
        matchesFound: complete.matchesFound,
        elapsedMs: complete.elapsedMs,
      });
      return { sessions: next };
    });
  }

  function idleSearch(wsId: string, ctrl: AbortController): void {
    if (controllers.get(wsId) !== ctrl) return;

    controllers.delete(wsId);

    set((state) => {
      const cur = state.sessions.get(wsId);
      if (!cur || cur.status !== "running") return state;
      const next = new Map(state.sessions);
      next.set(wsId, { ...cur, status: "idle" });
      return { sessions: next };
    });
  }

  function failSearch(wsId: string, ctrl: AbortController, message: string): void {
    if (controllers.get(wsId) !== ctrl) return;

    controllers.delete(wsId);

    set((state) => {
      const cur = state.sessions.get(wsId);
      if (!cur) return state;
      const next = new Map(state.sessions);
      next.set(wsId, { ...cur, status: "error", errorMessage: message });
      return { sessions: next };
    });
  }

  return {
    sessions: new Map(),
    viewStates: new Map(),

    loadViewOptions(wsId) {
      // Skip if already loaded for this workspace.
      if (get().viewStates.has(wsId)) return;

      // Set defaults immediately so components render without waiting for IPC.
      set((state) => {
        if (state.viewStates.has(wsId)) return state;
        const next = new Map(state.viewStates);
        next.set(wsId, { ...DEFAULT_SEARCH_VIEW, expandedDirs: new Set() });
        return { viewStates: next };
      });

      if (!canUseIpcBridge()) return;

      ipcCall("panel", "getViewOptions", { workspaceId: wsId, panelKind: "search" })
        .then((opts) => {
          set((state) => {
            const cur = state.viewStates.get(wsId);
            const next = new Map(state.viewStates);
            next.set(wsId, {
              viewMode: opts.viewMode,
              compactFolders: opts.compactFolders,
              // Preserve in-memory expandedDirs; IPC load only touches persisted fields.
              expandedDirs: cur?.expandedDirs ?? new Set(),
            });
            return { viewStates: next };
          });
        })
        .catch((error: unknown) => {
          console.error("[search] getViewOptions failed", error);
        });
    },

    setViewMode(wsId, next) {
      set((state) => {
        const cur = state.viewStates.get(wsId) ?? {
          ...DEFAULT_SEARCH_VIEW,
          expandedDirs: new Set(),
        };
        const updated: SearchViewState = { ...cur, viewMode: next };
        const map = new Map(state.viewStates);
        map.set(wsId, updated);
        scheduleViewOptionsSave(wsId, updated.viewMode, updated.compactFolders);
        return { viewStates: map };
      });
    },

    setCompactFolders(wsId, next) {
      set((state) => {
        const cur = state.viewStates.get(wsId) ?? {
          ...DEFAULT_SEARCH_VIEW,
          expandedDirs: new Set(),
        };
        const updated: SearchViewState = { ...cur, compactFolders: next };
        const map = new Map(state.viewStates);
        map.set(wsId, updated);
        scheduleViewOptionsSave(wsId, updated.viewMode, updated.compactFolders);
        return { viewStates: map };
      });
    },

    toggleExpandedDir(wsId, relPath) {
      set((state) => {
        const cur = state.viewStates.get(wsId) ?? {
          ...DEFAULT_SEARCH_VIEW,
          expandedDirs: new Set(),
        };
        const nextDirs = new Set(cur.expandedDirs);
        if (nextDirs.has(relPath)) {
          nextDirs.delete(relPath);
        } else {
          nextDirs.add(relPath);
        }
        const map = new Map(state.viewStates);
        map.set(wsId, { ...cur, expandedDirs: nextDirs });
        return { viewStates: map };
      });
    },

    startSearch(wsId, query, options) {
      const prior = controllers.get(wsId);
      if (prior) {
        prior.abort();
        controllers.delete(wsId);
      }

      const ctrl = new AbortController();
      controllers.set(wsId, ctrl);

      set((state) => {
        const next = new Map(state.sessions);
        next.set(wsId, {
          query,
          options,
          results: [],
          status: "running",
          limitHit: false,
          filesScanned: 0,
          matchesFound: 0,
          elapsedMs: 0,
          errorMessage: undefined,
        });
        return { sessions: next };
      });

      const tsq = { pattern: query, ...options } as TextSearchQuery;
      const stream = ipcStream(
        "fs",
        "searchText",
        { workspaceId: wsId, query: tsq },
        {
          signal: ctrl.signal,
        },
      );

      stream.onProgress((batch) => {
        if (controllers.get(wsId) !== ctrl) return;
        appendBatch(wsId, batch);
      });

      stream.promise
        .then((complete) => {
          finishSearch(wsId, ctrl, complete);
        })
        .catch((err: unknown) => {
          const errObj = err as { name?: string; message?: string };
          if (errObj?.name === "AbortError") {
            idleSearch(wsId, ctrl);
            return;
          }
          failSearch(wsId, ctrl, errObj?.message ?? String(err));
        });
    },

    cancelSearch(wsId) {
      const ctrl = controllers.get(wsId);
      if (ctrl) {
        ctrl.abort();
        controllers.delete(wsId);
      }
      set((state) => {
        const cur = state.sessions.get(wsId);
        if (!cur || cur.status !== "running") return state;
        const next = new Map(state.sessions);
        next.set(wsId, { ...cur, status: "idle" });
        return { sessions: next };
      });
    },

    clearSearch(wsId) {
      const ctrl = controllers.get(wsId);
      if (ctrl) {
        ctrl.abort();
        controllers.delete(wsId);
      }
      set((state) => {
        if (!state.sessions.has(wsId)) return state;
        const next = new Map(state.sessions);
        next.delete(wsId);
        return { sessions: next };
      });
    },

    toggleGroup(wsId, relPath) {
      set((state) => {
        const session = state.sessions.get(wsId);
        if (!session) return state;
        const next = new Map(state.sessions);
        next.set(wsId, {
          ...session,
          results: session.results.map((g) =>
            g.relPath === relPath ? { ...g, expanded: !g.expanded } : g,
          ),
        });
        return { sessions: next };
      });
    },

    closeAllForWorkspace(wsId) {
      const ctrl = controllers.get(wsId);
      if (ctrl) {
        ctrl.abort();
        controllers.delete(wsId);
      }
      // Cancel any pending view-options debounce for this workspace.
      const timer = viewOptionsSaveTimers.get(wsId);
      if (timer) {
        clearTimeout(timer);
        viewOptionsSaveTimers.delete(wsId);
      }
      set((state) => {
        const nextSessions = new Map(state.sessions);
        nextSessions.delete(wsId);
        // Reset expandedDirs (session-scoped) but keep persisted viewMode/compactFolders.
        const nextViewStates = new Map(state.viewStates);
        const cur = state.viewStates.get(wsId);
        if (cur) {
          nextViewStates.set(wsId, { ...cur, expandedDirs: new Set() });
        }
        if (!state.sessions.has(wsId) && !state.viewStates.has(wsId)) return state;
        return { sessions: nextSessions, viewStates: nextViewStates };
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Selector helpers
// ---------------------------------------------------------------------------

/**
 * Subscribes to a single workspace's search session slice. Returns `undefined`
 * when no search has been performed yet for that workspace; consumers should
 * fall back to an idle view in that case.
 */
export function useSearchSession(workspaceId: string): SearchSession | undefined {
  return useSearchStore((s) => s.sessions.get(workspaceId));
}

/**
 * Stable fallback reference for `useSearchViewState`. Returning a fresh object
 * (or fresh Set) from a `useSyncExternalStore` selector triggers React's
 * "getSnapshot should be cached" warning and can cause infinite re-renders, so
 * we reuse a single immutable snapshot when no per-workspace state exists yet.
 * Mutators in this file always construct fresh maps/sets before storing, so
 * this default is never mutated in place.
 */
const EMPTY_SEARCH_VIEW_STATE: SearchViewState = DEFAULT_SEARCH_VIEW;

export function useSearchViewState(workspaceId: string): SearchViewState {
  return useSearchStore((s) => s.viewStates.get(workspaceId) ?? EMPTY_SEARCH_VIEW_STATE);
}
