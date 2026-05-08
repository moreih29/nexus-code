import { create } from "zustand";
import type {
  FileMatch,
  SearchComplete,
  SearchRange,
  TextSearchQuery,
} from "../../../shared/types/search";
import { ipcCall, ipcListen } from "../../ipc/client";
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
  requestId: string | null;
  errorMessage?: string;
}

interface SearchState {
  sessions: Map<string, SearchSession>;
  startSearch: (workspaceId: string, query: string, options: SearchOptions) => void;
  cancelSearch: (workspaceId: string) => void;
  toggleGroup: (workspaceId: string, relPath: string) => void;
  closeAllForWorkspace: (workspaceId: string) => void;
}

// ---------------------------------------------------------------------------
// Module-scoped AbortController map — lives outside zustand so abort() calls
// never trigger a state re-render.
// ---------------------------------------------------------------------------

const controllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Internal helper bridge — assigned by the store's create() callback so tests
// can call them directly without going through the IPC listener path.
// The store is created synchronously at module load, so _storeHelpers is
// populated before any test code can run.
// ---------------------------------------------------------------------------

interface StoreHelpers {
  appendBatch: (requestId: string, batch: FileMatch[]) => void;
  finishSearch: (wsId: string, requestId: string, complete: SearchComplete) => void;
  failSearch: (wsId: string, requestId: string, message: string) => void;
}

// Declare before create() so the callback can assign into it without TDZ errors.
// Production code should never call these directly.
export let _storeHelpers: StoreHelpers = {
  appendBatch: () => {},
  finishSearch: () => {},
  failSearch: () => {},
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSearchStore = create<SearchState>((set, get) => {
  // Wire searchProgress listen events to the batch-append helper.
  // typeof window guard keeps this safe under bun:test without a DOM.
  if (typeof window !== "undefined") {
    ipcListen("fs", "searchProgress", ({ requestId, batch }) => {
      appendBatch(requestId, batch);
    });
  }

  registerWorkspaceCleanup((id) => {
    get().closeAllForWorkspace(id);
  });

  // ------------------------------------------------------------------
  // Internal helpers — closed over set/get; exported at module scope
  // below so tests can call them directly without going through the
  // IPC listener (which is skipped in bun:test's window-less env).
  // ------------------------------------------------------------------

  function appendBatch(requestId: string, batch: FileMatch[]): void {
    // Find the workspace whose current session owns this requestId.
    for (const [wsId, session] of get().sessions) {
      if (session.requestId === requestId) {
        _appendBatchForSession(wsId, requestId, batch);
        return;
      }
    }
    // Stale or unknown requestId — drop silently.
  }

  function _appendBatchForSession(wsId: string, requestId: string, batch: FileMatch[]): void {
    const session = get().sessions.get(wsId);
    if (!session || session.requestId !== requestId) return;

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
      if (!cur || cur.requestId !== requestId) return state;
      const next = new Map(state.sessions);
      next.set(wsId, {
        ...cur,
        results: nextResults,
        matchesFound: cur.matchesFound + addedMatches,
      });
      return { sessions: next };
    });
  }

  function finishSearch(wsId: string, requestId: string, complete: SearchComplete): void {
    const session = get().sessions.get(wsId);
    if (!session || session.requestId !== requestId) return;

    controllers.delete(wsId);

    set((state) => {
      const cur = state.sessions.get(wsId);
      if (!cur || cur.requestId !== requestId) return state;
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

  function failSearch(wsId: string, requestId: string, message: string): void {
    const session = get().sessions.get(wsId);
    if (!session || session.requestId !== requestId) return;

    controllers.delete(wsId);

    set((state) => {
      const cur = state.sessions.get(wsId);
      if (!cur || cur.requestId !== requestId) return state;
      const next = new Map(state.sessions);
      next.set(wsId, { ...cur, status: "error", errorMessage: message });
      return { sessions: next };
    });
  }

  // Bind module-level exports to this store instance's set/get.
  _storeHelpers = { appendBatch, finishSearch, failSearch };

  return {
    sessions: new Map(),

    startSearch(wsId, query, options) {
      const prior = controllers.get(wsId);
      if (prior) {
        prior.abort();
        controllers.delete(wsId);
      }

      const ctrl = new AbortController();
      controllers.set(wsId, ctrl);
      const requestId = crypto.randomUUID();

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
          requestId,
          errorMessage: undefined,
        });
        return { sessions: next };
      });

      const tsq = { pattern: query, ...options } as TextSearchQuery;

      ipcCall("fs", "searchText", { workspaceId: wsId, query: tsq }, { signal: ctrl.signal })
        .then((complete) => {
          finishSearch(wsId, requestId, complete);
          if (controllers.get(wsId) === ctrl) controllers.delete(wsId);
        })
        .catch((err: unknown) => {
          const errObj = err as { name?: string; message?: string };
          if (errObj?.name === "AbortError") {
            // Walker absorbed AbortError and returned a partial SearchComplete;
            // the renderer's requestId guard drops stale finish events from
            // cancelled queries.
            if (controllers.get(wsId) === ctrl) controllers.delete(wsId);
            return;
          }
          failSearch(wsId, requestId, errObj?.message ?? String(err));
          if (controllers.get(wsId) === ctrl) controllers.delete(wsId);
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
      set((state) => {
        if (!state.sessions.has(wsId)) return state;
        const next = new Map(state.sessions);
        next.delete(wsId);
        return { sessions: next };
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Selector helper
// ---------------------------------------------------------------------------

export function useSearchSession(workspaceId: string): SearchSession | undefined {
  return useSearchStore((s) => s.sessions.get(workspaceId));
}
