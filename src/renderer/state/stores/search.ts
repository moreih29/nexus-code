import { create } from "zustand";
import type {
  FileMatch,
  SearchComplete,
  SearchRange,
  TextSearchQuery,
} from "../../../shared/search/types";
import { ipcStream } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";
import { usePanelViewOptionsStore } from "./panel-view-options";

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

interface SearchState {
  sessions: Map<string, SearchSession>;
  /** Per-workspace expanded directory paths — session-scoped, NOT persisted. */
  expandedDirsByWorkspace: Map<string, Set<string>>;
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
  /** Toggle a directory's expanded state (session-scoped, not persisted). */
  toggleExpandedDir: (workspaceId: string, relPath: string) => void;
}

// ---------------------------------------------------------------------------
// Module-scoped AbortController map — lives outside zustand so abort() calls
// never trigger a state re-render.
// ---------------------------------------------------------------------------

const controllers = new Map<string, AbortController>();

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
    expandedDirsByWorkspace: new Map(),

    toggleExpandedDir(wsId, relPath) {
      set((state) => {
        const cur = state.expandedDirsByWorkspace.get(wsId) ?? new Set<string>();
        const nextDirs = new Set(cur);
        if (nextDirs.has(relPath)) {
          nextDirs.delete(relPath);
        } else {
          nextDirs.add(relPath);
        }
        const map = new Map(state.expandedDirsByWorkspace);
        map.set(wsId, nextDirs);
        return { expandedDirsByWorkspace: map };
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
      // Delegate view-option timer cancellation to the shared store.
      usePanelViewOptionsStore.getState().closeForWorkspace(wsId);
      set((state) => {
        const nextSessions = new Map(state.sessions);
        nextSessions.delete(wsId);
        // Reset expandedDirs (session-scoped) for this workspace.
        const nextExpandedDirs = new Map(state.expandedDirsByWorkspace);
        nextExpandedDirs.delete(wsId);
        if (!state.sessions.has(wsId) && !state.expandedDirsByWorkspace.has(wsId)) return state;
        return { sessions: nextSessions, expandedDirsByWorkspace: nextExpandedDirs };
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
 * Subscribes to the expanded directories set for a workspace.
 * Returns an empty frozen set when none exists yet (stable reference —
 * avoids React getSnapshot warning).
 */
const EMPTY_EXPANDED_DIRS: ReadonlySet<string> = Object.freeze(new Set<string>());

export function useSearchExpandedDirs(workspaceId: string): ReadonlySet<string> {
  return useSearchStore(
    (s) => s.expandedDirsByWorkspace.get(workspaceId) ?? EMPTY_EXPANDED_DIRS,
  );
}
