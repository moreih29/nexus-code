import i18next from "i18next";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitDetail, CommitSearchResult, LogEntry } from "../../../../../shared/git/types";
import { ipcCallResult, ipcStream, unwrapGitResult } from "../../../../ipc/client";
import type { LaneState } from "./graph/lane-assign";
import { initialLaneState, reduceLanes } from "./graph/lane-assign";

const HISTORY_PAGE_SIZE = 50;
const HISTORY_SEARCH_DEBOUNCE_MS = 200;

export interface HistoryLoadState {
  entries: LogEntry[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  errorMessage: string | null;
}

export interface UseGitHistoryLoadResult {
  loadState: HistoryLoadState;
  laneState: LaneState;
  query: string;
  debouncedQuery: string;
  selectedSha: string | null;
  setQuery: (query: string) => void;
  setSelectedSha: React.Dispatch<React.SetStateAction<string | null>>;
  loadMore: () => void;
  refresh: () => void;
}

export function useGitHistoryLoad(workspaceId: string, refName: string): UseGitHistoryLoadResult {
  const [query, setQuery] = useState("");
  const [searchNonce, setSearchNonce] = useState(0);
  const debouncedQuery = useDebouncedValue(query, HISTORY_SEARCH_DEBOUNCE_MS);

  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<HistoryLoadState>(emptyLoadState(true));
  const [laneState, setLaneState] = useState(() => initialLaneState());

  const loadTokenRef = useRef(0);
  const nextLoadToken = useCallback((): number => {
    loadTokenRef.current += 1;
    return loadTokenRef.current;
  }, []);
  const isCurrentLoad = useCallback((token: number): boolean => {
    return loadTokenRef.current === token;
  }, []);

  const resetLaneState = useCallback(() => {
    setLaneState(initialLaneState());
  }, []);

  const appendLaneChunk = useCallback((chunk: readonly LogEntry[]) => {
    if (chunk.length === 0) return;
    setLaneState((state) => reduceLanes(state, chunk));
  }, []);

  const loadFirstPage = useCallback(
    (signal?: AbortSignal) => {
      const token = nextLoadToken();
      setSelectedSha(null);
      resetLaneState();
      setLoadState(emptyLoadState(true));
      void runLogLoad(token, isCurrentLoad, appendLaneChunk, setLoadState, setSelectedSha, {
        workspaceId,
        refName,
        scope: "ref",
        signal,
      });
    },
    [appendLaneChunk, isCurrentLoad, nextLoadToken, refName, resetLaneState, workspaceId],
  );

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    const refreshToken = searchNonce;
    if (trimmed.length > 0) {
      const controller = new AbortController();
      const token = nextLoadToken();
      resetLaneState();
      setLoadState(emptyLoadState(true));
      setSelectedSha(null);
      if (isShaPrefixQuery(trimmed)) {
        ipcCallResult(
          "git",
          "searchCommits",
          { workspaceId, query: trimmed, limit: HISTORY_PAGE_SIZE },
          { signal: controller.signal },
        )
          .then((ipcRes) => {
            if (controller.signal.aborted || !isCurrentLoad(token)) return;
            const result = unwrapGitResult(ipcRes);
            const graphEntries = applySearchResult(result, setLoadState, setSelectedSha);
            setLaneState(reduceLanes(initialLaneState(), graphEntries));
          })
          .catch((error) => {
            if (controller.signal.aborted || !isCurrentLoad(token)) return;
            const message =
              gitErrorKind(error) === "ref-not-found" ? null : messageFromError(error);
            setLoadState({
              entries: [],
              hasMore: false,
              loading: false,
              loadingMore: false,
              errorMessage: message,
            });
          });
      } else {
        void runLogLoad(token, isCurrentLoad, appendLaneChunk, setLoadState, setSelectedSha, {
          workspaceId,
          refName,
          scope: "ref",
          grep: trimmed,
          signal: controller.signal,
        });
      }
      return () => controller.abort();
    }
    if (refreshToken < 0) return;

    const controller = new AbortController();
    setLoadState((state) => ({ ...state, loading: true, entries: [], errorMessage: null }));
    loadFirstPage(controller.signal);
    return () => controller.abort();
  }, [
    appendLaneChunk,
    debouncedQuery,
    isCurrentLoad,
    loadFirstPage,
    nextLoadToken,
    refName,
    resetLaneState,
    searchNonce,
    workspaceId,
  ]);

  const loadMore = useCallback(() => {
    if (debouncedQuery.trim().length > 0) return;
    const lastSha = loadState.entries.at(-1)?.sha;
    if (!lastSha || loadState.loadingMore) return;
    const laneSeenShas = new Set(loadState.entries.map((entry) => entry.sha));
    const token = nextLoadToken();
    setLoadState((state) => ({ ...state, loadingMore: true }));
    void loadLogPage({
      workspaceId,
      refName,
      scope: "ref",
      afterSha: lastSha,
      signal: undefined,
      onChunk: (entries, chunk) => {
        if (!isCurrentLoad(token)) return;
        appendLaneChunk(collectNewLaneEntries(laneSeenShas, chunk));
        setLoadState((state) => ({
          ...state,
          entries: appendUniqueEntries(state.entries, entries),
          loadingMore: false,
          errorMessage: null,
        }));
      },
      onComplete: (hasMore) => {
        if (!isCurrentLoad(token)) return;
        setLoadState((state) => ({ ...state, loadingMore: false, hasMore }));
      },
      onError: (message) => {
        if (!isCurrentLoad(token)) return;
        setLoadState((state) => ({ ...state, loadingMore: false, errorMessage: message }));
      },
    });
  }, [
    appendLaneChunk,
    debouncedQuery,
    isCurrentLoad,
    loadState.entries,
    loadState.loadingMore,
    nextLoadToken,
    refName,
    workspaceId,
  ]);

  const refresh = useCallback(() => {
    if (debouncedQuery.trim().length > 0) {
      setSearchNonce((value) => value + 1);
    } else {
      loadFirstPage();
    }
  }, [debouncedQuery, loadFirstPage]);

  return {
    loadState,
    laneState,
    query,
    debouncedQuery,
    selectedSha,
    setQuery,
    setSelectedSha,
    loadMore,
    refresh,
  };
}

function runLogLoad(
  token: number,
  isCurrentLoad: (token: number) => boolean,
  appendLaneChunk: (chunk: readonly LogEntry[]) => void,
  setLoadState: React.Dispatch<React.SetStateAction<HistoryLoadState>>,
  setSelectedSha: React.Dispatch<React.SetStateAction<string | null>>,
  opts: {
    workspaceId: string;
    refName: string;
    scope: "ref";
    afterSha?: string;
    grep?: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  return loadLogPage({
    workspaceId: opts.workspaceId,
    refName: opts.refName,
    scope: opts.scope,
    afterSha: opts.afterSha,
    grep: opts.grep,
    signal: opts.signal,
    onChunk: (entries, chunk) => {
      if (!isCurrentLoad(token)) return;
      appendLaneChunk(chunk);
      setLoadState((state) => ({
        ...state,
        entries,
        loading: false,
        errorMessage: null,
      }));
      setSelectedSha((current) => current ?? entries[0]?.sha ?? null);
    },
    onComplete: (hasMore) => {
      if (!isCurrentLoad(token)) return;
      setLoadState((state) => ({ ...state, loading: false, hasMore }));
    },
    onError: (message) => {
      if (!isCurrentLoad(token)) return;
      setLoadState({
        entries: [],
        hasMore: false,
        loading: false,
        loadingMore: false,
        errorMessage: message,
      });
    },
  });
}

async function loadLogPage({
  workspaceId,
  refName,
  scope,
  afterSha,
  grep,
  signal,
  onChunk,
  onComplete,
  onError,
}: {
  workspaceId: string;
  refName: string;
  scope: "ref";
  afterSha?: string;
  grep?: string;
  signal?: AbortSignal;
  onChunk: (entries: LogEntry[], chunk: readonly LogEntry[]) => void;
  onComplete: (hasMore: boolean) => void;
  onError: (message: string) => void;
}): Promise<void> {
  const entries: LogEntry[] = [];
  try {
    const trimmedGrep = grep?.trim();
    const handle = ipcStream(
      "git",
      "log",
      {
        workspaceId,
        ref: scope === "ref" ? refName : undefined,
        scope,
        afterSha,
        grep: trimmedGrep && trimmedGrep.length > 0 ? trimmedGrep : undefined,
        limit: HISTORY_PAGE_SIZE,
      },
      signal ? { signal } : {},
    );
    handle.onProgress((chunk) => {
      if (signal?.aborted) return;
      entries.push(...chunk.entries);
      onChunk([...entries], chunk.entries);
    });
    const complete = await handle.promise;
    if (signal?.aborted) return;
    onComplete(Boolean(complete.hasMore));
  } catch (error) {
    if (signal?.aborted) return;
    if (gitErrorKind(error) === "no-head") {
      onComplete(false);
      return;
    }
    onError(messageFromError(error));
  }
}

function applySearchResult(
  result: CommitSearchResult,
  setLoadState: React.Dispatch<React.SetStateAction<HistoryLoadState>>,
  setSelectedSha: React.Dispatch<React.SetStateAction<string | null>>,
): readonly LogEntry[] {
  if (result.kind === "sha") {
    const entry = logEntryFromDetail(result.detail);
    setLoadState({
      entries: [entry],
      hasMore: false,
      loading: false,
      loadingMore: false,
      errorMessage: null,
    });
    setSelectedSha(result.detail.sha);
    return [entry];
  }

  setLoadState({
    entries: result.entries,
    hasMore: false,
    loading: false,
    loadingMore: false,
    errorMessage: null,
  });
  setSelectedSha(result.entries[0]?.sha ?? null);
  return result.entries;
}

function emptyLoadState(loading: boolean): HistoryLoadState {
  return {
    entries: [],
    hasMore: false,
    loading,
    loadingMore: false,
    errorMessage: null,
  };
}

function logEntryFromDetail(detail: CommitDetail): LogEntry {
  return {
    sha: detail.sha,
    shortSha: detail.sha.slice(0, 7),
    parents: detail.parents,
    authorName: detail.author,
    authorEmail: detail.authorEmail,
    authoredAt: detail.committerTs,
    subject: detail.subject,
    body: detail.body || undefined,
    refs: [],
  };
}

function appendUniqueEntries(current: readonly LogEntry[], nextPage: readonly LogEntry[]) {
  const seen = new Set(current.map((entry) => entry.sha));
  const appended = nextPage.filter((entry) => !seen.has(entry.sha));
  return [...current, ...appended];
}

function collectNewLaneEntries(seenShas: Set<string>, chunk: readonly LogEntry[]): LogEntry[] {
  const freshEntries: LogEntry[] = [];
  for (const entry of chunk) {
    if (seenShas.has(entry.sha)) continue;
    seenShas.add(entry.sha);
    freshEntries.push(entry);
  }
  return freshEntries;
}

function isShaPrefixQuery(query: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(query.trim());
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : i18next.t("files:git.history.list.loadFailed");
}

function gitErrorKind(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind;
    return typeof kind === "string" ? kind : null;
  }
  return null;
}
