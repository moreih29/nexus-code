/**
 * History panel orchestrator — loads paged logs, server-side search, and the
 * commit detail split view for one workspace.
 */
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CommitDetail,
  CommitSearchResult,
  GitHistoryScope,
  LogEntry,
} from "../../../../../shared/types/git";
import { ipcCall, ipcStream } from "../../../../ipc/client";
import { useGitStore } from "../../../../state/stores/git";
import { GitInlineBanner } from "../GitInlineBanner";
import { initialLaneState, reduceLanes } from "./graph/lane-assign";
import { HistoryCommitMenu, type HistoryCommitMenuTarget } from "./HistoryCommitMenu";
import { HistoryDetail } from "./HistoryDetail";
import { HistoryList } from "./HistoryList";
import { HistoryRefSwitcher } from "./HistoryRefSwitcher";
import type { HistoryRowMenuRequest } from "./HistoryRow";
import { HistorySearch } from "./HistorySearch";
import { RefChipList } from "./RefChip";

const HISTORY_PAGE_SIZE = 50;
const HISTORY_SEARCH_DEBOUNCE_MS = 200;
const HISTORY_NARROW_WIDTH = 720;

interface HistoryPanelProps {
  workspaceId: string;
  refName: string;
  historyScope: GitHistoryScope;
  detailWidth: number;
  busy?: boolean;
  onRefChange: (refName: string) => void;
  onScopeChange: (scope: GitHistoryScope) => void;
  onDetailWidthChange: (width: number) => void;
}

interface HistoryLoadState {
  entries: LogEntry[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  errorMessage: string | null;
}

/** Renders the full History MVP surface. */
export function HistoryPanel({
  workspaceId,
  refName,
  historyScope,
  detailWidth,
  busy = false,
  onRefChange,
  onScopeChange,
  onDetailWidthChange,
}: HistoryPanelProps) {
  const cherryPick = useGitStore((state) => state.cherryPick);
  const checkoutDetached = useGitStore((state) => state.checkoutDetached);
  const resetSoft = useGitStore((state) => state.resetSoft);
  const [query, setQuery] = useState("");
  const [searchNonce, setSearchNonce] = useState(0);
  const debouncedQuery = useDebouncedValue(query, HISTORY_SEARCH_DEBOUNCE_MS);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [menuTarget, setMenuTarget] = useState<HistoryCommitMenuTarget | null>(null);
  const [banner, setBanner] = useState<{ variant: "info" | "error"; message: string } | null>(null);
  const [loadState, setLoadState] = useState<HistoryLoadState>({
    entries: [],
    hasMore: false,
    loading: true,
    loadingMore: false,
    errorMessage: null,
  });
  const [laneState, setLaneState] = useState(() => initialLaneState());
  const narrow = useIsNarrowHistoryLayout();
  const selectedEntry = useMemo(
    () => loadState.entries.find((entry) => entry.sha === selectedSha) ?? null,
    [loadState.entries, selectedSha],
  );

  const resetLaneState = useCallback(() => {
    setLaneState(initialLaneState());
  }, []);

  const appendLaneChunk = useCallback((chunk: readonly LogEntry[]) => {
    if (chunk.length === 0) return;
    setLaneState((state) => reduceLanes(state, chunk));
  }, []);

  const changeHistoryRef = useCallback(
    (nextRefName: string) => {
      onRefChange(nextRefName);
      onScopeChange("ref");
      setQuery("");
    },
    [onRefChange, onScopeChange],
  );

  const loadFirstPage = useCallback(
    (signal?: AbortSignal) => {
      setBanner(null);
      setDetail(null);
      setSelectedSha(null);
      resetLaneState();
      setLoadState({
        entries: [],
        hasMore: false,
        loading: true,
        loadingMore: false,
        errorMessage: null,
      });
      void loadLogPage({
        workspaceId,
        refName,
        scope: historyScope,
        signal,
        onChunk: (entries, chunk) => {
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
          setLoadState((state) => ({ ...state, loading: false, hasMore }));
        },
        onError: (message) => {
          setLoadState({
            entries: [],
            hasMore: false,
            loading: false,
            loadingMore: false,
            errorMessage: message,
          });
        },
      });
    },
    [appendLaneChunk, historyScope, refName, resetLaneState, workspaceId],
  );

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    const refreshToken = searchNonce;
    if (trimmed.length > 0) {
      const controller = new AbortController();
      resetLaneState();
      setLoadState({
        entries: [],
        hasMore: false,
        loading: true,
        loadingMore: false,
        errorMessage: null,
      });
      setDetail(null);
      setSelectedSha(null);
      if (historyScope === "ref" && isShaPrefixQuery(trimmed)) {
        ipcCall(
          "git",
          "searchCommits",
          { workspaceId, query: trimmed, limit: HISTORY_PAGE_SIZE },
          {
            signal: controller.signal,
          },
        )
          .then((result) => {
            if (controller.signal.aborted) return;
            const graphEntries = applySearchResult(result, setLoadState, setSelectedSha, setDetail);
            setLaneState(reduceLanes(initialLaneState(), graphEntries));
          })
          .catch((error) => {
            if (controller.signal.aborted) return;
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
        void loadLogPage({
          workspaceId,
          refName,
          scope: historyScope,
          grep: trimmed,
          signal: controller.signal,
          onChunk: (entries, chunk) => {
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
            setLoadState((state) => ({ ...state, loading: false, hasMore }));
          },
          onError: (message) => {
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
    historyScope,
    loadFirstPage,
    refName,
    resetLaneState,
    searchNonce,
    workspaceId,
  ]);

  useEffect(() => {
    if (!selectedSha) {
      setDetail(null);
      return;
    }
    if (detail?.sha === selectedSha) return;

    const controller = new AbortController();
    setDetailLoading(true);
    ipcCall("git", "commitDetail", { workspaceId, sha: selectedSha }, { signal: controller.signal })
      .then((nextDetail) => setDetail(nextDetail))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setBanner({ variant: "error", message: messageFromError(error) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [detail?.sha, selectedSha, workspaceId]);

  function loadMore(): void {
    if (debouncedQuery.trim().length > 0) return;
    const lastSha = loadState.entries.at(-1)?.sha;
    if (!lastSha || loadState.loadingMore) return;
    const laneSeenShas = new Set(loadState.entries.map((entry) => entry.sha));
    setLoadState((state) => ({ ...state, loadingMore: true }));
    void loadLogPage({
      workspaceId,
      refName,
      scope: historyScope,
      afterSha: lastSha,
      signal: undefined,
      onChunk: (entries, chunk) => {
        appendLaneChunk(collectNewLaneEntries(laneSeenShas, chunk));
        setLoadState((state) => ({
          ...state,
          entries: appendUniqueEntries(state.entries, entries),
          loadingMore: false,
          errorMessage: null,
        }));
      },
      onComplete: (hasMore) => {
        setLoadState((state) => ({ ...state, loadingMore: false, hasMore }));
      },
      onError: (message) => {
        setLoadState((state) => ({ ...state, loadingMore: false, errorMessage: message }));
      },
    });
  }

  function openMenu(request: HistoryRowMenuRequest): void {
    setMenuTarget({
      entry: request.entry,
      detail: detail?.sha === request.entry.sha ? detail : null,
      point: request.point,
    });
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <HistoryRefSwitcher
        workspaceId={workspaceId}
        refName={refName}
        historyScope={historyScope}
        searchQuery={query}
        disabled={busy}
        onRefChange={changeHistoryRef}
        onScopeChange={onScopeChange}
        onRefresh={() => {
          if (debouncedQuery.trim().length > 0) {
            setSearchNonce((value) => value + 1);
          } else {
            loadFirstPage();
          }
        }}
      />
      <HistorySearch
        value={query}
        disabled={busy}
        onChange={setQuery}
        onClear={() => setQuery("")}
      />
      {banner ? <GitInlineBanner variant={banner.variant} message={banner.message} /> : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-auto app-scrollbar">
          <HistoryList
            entries={loadState.entries}
            selectedSha={selectedSha}
            loading={loadState.loading}
            loadingMore={loadState.loadingMore}
            hasMore={loadState.hasMore}
            searchQuery={query}
            errorMessage={loadState.errorMessage}
            laneState={laneState}
            renderRefSlot={(entry) => (
              <RefChipList
                refs={entry.refs}
                currentRefName={refName}
                visibleCount={narrow ? 1 : 2}
                onRefChange={changeHistoryRef}
                onOpenMenu={(event) => {
                  openMenu({ entry, point: { x: event.clientX, y: event.clientY } });
                }}
              />
            )}
            onSelect={(entry) => setSelectedSha(entry.sha)}
            onLoadMore={loadMore}
            onOpenMenu={openMenu}
            onClearSearch={() => setQuery("")}
          />
        </div>
        <HistoryDetail
          detail={detail}
          loading={detailLoading}
          width={detailWidth}
          narrow={narrow}
          selectedEntry={selectedEntry}
          onWidthChange={onDetailWidthChange}
          onClose={() => {
            setSelectedSha(null);
            setDetail(null);
          }}
          onOpenMenu={openMenu}
        />
      </div>
      <HistoryCommitMenu
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        actions={{
          cherryPick: (sha) => {
            void cherryPick(workspaceId, sha).then((ok) => {
              if (ok) setBanner({ variant: "info", message: "Cherry-pick started." });
            });
          },
          checkoutDetached: (sha) => {
            void checkoutDetached(workspaceId, sha);
          },
          resetSoft: (sha) => {
            void resetSoft(workspaceId, sha);
          },
        }}
      />
    </div>
  );
}

/** Loads one log page through the stream API and appends progress chunks. */
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
  scope: GitHistoryScope;
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
        ref: scope === "ref" && !afterSha ? refName : undefined,
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
    onError(messageFromError(error));
  }
}

/** Applies a server-side search result to list and detail state. */
function applySearchResult(
  result: CommitSearchResult,
  setLoadState: React.Dispatch<React.SetStateAction<HistoryLoadState>>,
  setSelectedSha: React.Dispatch<React.SetStateAction<string | null>>,
  setDetail: React.Dispatch<React.SetStateAction<CommitDetail | null>>,
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
    setDetail(result.detail);
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

/** Converts a detail response into the list-row shape for SHA search hits. */
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

/** Appends log entries while guarding against duplicate chunks. */
function appendUniqueEntries(current: readonly LogEntry[], nextPage: readonly LogEntry[]) {
  const seen = new Set(current.map((entry) => entry.sha));
  const appended = nextPage.filter((entry) => !seen.has(entry.sha));
  return [...current, ...appended];
}

/** Returns only chunk entries that have not already advanced the graph reducer. */
function collectNewLaneEntries(seenShas: Set<string>, chunk: readonly LogEntry[]): LogEntry[] {
  const freshEntries: LogEntry[] = [];
  for (const entry of chunk) {
    if (seenShas.has(entry.sha)) continue;
    seenShas.add(entry.sha);
    freshEntries.push(entry);
  }
  return freshEntries;
}

/** Matches the legacy SHA-prefix search path for single-ref history queries. */
function isShaPrefixQuery(query: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(query.trim());
}

/** Small debounce hook used for History search. */
function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

/** Tracks whether History detail should switch from split pane to sheet. */
function useIsNarrowHistoryLayout(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < HISTORY_NARROW_WIDTH,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setNarrow(window.innerWidth < HISTORY_NARROW_WIDTH);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return narrow;
}

/** Extracts a user-facing message from unknown IPC failures. */
function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Git history operation failed.";
}

/** Reads the stable git error kind rehydrated by the renderer IPC layer. */
function gitErrorKind(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind;
    return typeof kind === "string" ? kind : null;
  }
  return null;
}
