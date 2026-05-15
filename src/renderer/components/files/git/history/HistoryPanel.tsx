/**
 * History panel orchestrator — loads paged logs and server-side search for
 * one workspace while commit details open in editor-area tabs.
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommitDetail,
  CommitSearchResult,
  GitHistoryScope,
  LogEntry,
} from "../../../../../shared/types/git";
import { ipcCall, ipcStream } from "../../../../ipc/client";
import { openOrRevealCommitTab } from "../../../../state/operations/tabs";
import { useGitStore } from "../../../../state/stores/git";
import { GitInlineBanner } from "../GitInlineBanner";
import { initialLaneState, reduceLanes } from "./graph/lane-assign";
import { HistoryCommitMenu, type HistoryCommitMenuTarget } from "./HistoryCommitMenu";
import { HistoryList } from "./HistoryList";
import { HistoryRefSwitcher } from "./HistoryRefSwitcher";
import type { HistoryRowMenuRequest } from "./HistoryRow";
import { HistorySearch } from "./HistorySearch";
import { RefChipList } from "./RefChip";

const HISTORY_PAGE_SIZE = 50;
const HISTORY_SEARCH_DEBOUNCE_MS = 200;

interface HistoryPanelProps {
  workspaceId: string;
  refName: string;
  historyScope: GitHistoryScope;
  busy?: boolean;
  onRefChange: (refName: string) => void;
  onScopeChange: (scope: GitHistoryScope) => void;
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
  busy = false,
  onRefChange,
  onScopeChange,
}: HistoryPanelProps) {
  // DIAGNOSTIC: assign a per-instance id and log mount/unmount so we can tell
  // whether the visible duplication comes from multiple panel instances
  // co-rendering or from a single instance whose state is doubled.
  const instanceIdRef = useRef<string | undefined>(undefined);
  if (instanceIdRef.current === undefined) {
    instanceIdRef.current = Math.random().toString(36).slice(2, 8);
    console.warn(`[history] mount instance=${instanceIdRef.current} ws=${workspaceId} ref=${refName} scope=${historyScope}`);
  }
  const instanceId = instanceIdRef.current;
  useEffect(() => {
    return () => {
      console.warn(`[history] unmount instance=${instanceId}`);
    };
  }, [instanceId]);

  const cherryPick = useGitStore((state) => state.cherryPick);
  const checkoutDetached = useGitStore((state) => state.checkoutDetached);
  const resetSoft = useGitStore((state) => state.resetSoft);
  const [query, setQuery] = useState("");
  const [searchNonce, setSearchNonce] = useState(0);
  const debouncedQuery = useDebouncedValue(query, HISTORY_SEARCH_DEBOUNCE_MS);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
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
  // Monotonic load token. Every new first-page / search / load-more run
  // increments the counter; the in-flight callbacks only commit state when
  // their captured token still matches. This blocks chunks from a load that
  // was logically superseded (e.g. workspace switch or rapid refresh) from
  // appending to a fresh entries list and producing a duplicated history.
  const loadTokenRef = useRef(0);
  const nextLoadToken = useCallback((): number => {
    loadTokenRef.current += 1;
    return loadTokenRef.current;
  }, []);
  const isCurrentLoad = useCallback((token: number): boolean => {
    return loadTokenRef.current === token;
  }, []);

  // DIAGNOSTIC: log every render with current entries shape so we can spot a
  // doubled state (entries.length === 21 with sha[0] === sha[7] === sha[14])
  // versus a duplicated render of a 7-entry state.
  console.warn(
    `[history] render instance=${instanceId} ws=${workspaceId} ref=${refName} entries=${loadState.entries.length} first=${loadState.entries[0]?.shortSha ?? "-"} last=${loadState.entries.at(-1)?.shortSha ?? "-"} loading=${loadState.loading} hasMore=${loadState.hasMore} token=${loadTokenRef.current}`,
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
      const token = nextLoadToken();
      console.warn(
        `[history] loadFirstPage instance=${instanceId} token=${token} ws=${workspaceId} ref=${refName} scope=${historyScope}`,
      );
      setBanner(null);
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
          if (!isCurrentLoad(token)) {
            console.warn(
              `[history] onChunk SKIPPED stale token=${token} current=${loadTokenRef.current} instance=${instanceId} chunk=${chunk.length} totalSoFar=${entries.length}`,
            );
            return;
          }
          console.warn(
            `[history] onChunk apply token=${token} instance=${instanceId} chunk=${chunk.length} totalSoFar=${entries.length} firstSha=${entries[0]?.shortSha ?? "-"}`,
          );
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
          if (!isCurrentLoad(token)) {
            console.warn(
              `[history] onComplete SKIPPED stale token=${token} current=${loadTokenRef.current} instance=${instanceId}`,
            );
            return;
          }
          console.warn(
            `[history] onComplete token=${token} instance=${instanceId} hasMore=${hasMore}`,
          );
          setLoadState((state) => ({ ...state, loading: false, hasMore }));
        },
        onError: (message) => {
          if (!isCurrentLoad(token)) return;
          console.warn(`[history] onError token=${token} instance=${instanceId} msg=${message}`);
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
    [
      appendLaneChunk,
      historyScope,
      instanceId,
      isCurrentLoad,
      nextLoadToken,
      refName,
      resetLaneState,
      workspaceId,
    ],
  );

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    const refreshToken = searchNonce;
    if (trimmed.length > 0) {
      const controller = new AbortController();
      const token = nextLoadToken();
      console.warn(
        `[history] effect search-start instance=${instanceId} token=${token} ws=${workspaceId} ref=${refName} q=${JSON.stringify(trimmed)}`,
      );
      resetLaneState();
      setLoadState({
        entries: [],
        hasMore: false,
        loading: true,
        loadingMore: false,
        errorMessage: null,
      });
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
            if (controller.signal.aborted || !isCurrentLoad(token)) return;
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
        void loadLogPage({
          workspaceId,
          refName,
          scope: historyScope,
          grep: trimmed,
          signal: controller.signal,
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
      return () => controller.abort();
    }
    if (refreshToken < 0) return;

    const controller = new AbortController();
    console.warn(
      `[history] effect first-page-start instance=${instanceId} ws=${workspaceId} ref=${refName} scope=${historyScope}`,
    );
    setLoadState((state) => ({ ...state, loading: true, entries: [], errorMessage: null }));
    loadFirstPage(controller.signal);
    return () => {
      console.warn(
        `[history] effect cleanup (abort) instance=${instanceId} ws=${workspaceId} ref=${refName}`,
      );
      controller.abort();
    };
  }, [
    appendLaneChunk,
    debouncedQuery,
    historyScope,
    instanceId,
    isCurrentLoad,
    loadFirstPage,
    nextLoadToken,
    refName,
    resetLaneState,
    searchNonce,
    workspaceId,
  ]);

  function loadMore(): void {
    if (debouncedQuery.trim().length > 0) return;
    const lastSha = loadState.entries.at(-1)?.sha;
    if (!lastSha || loadState.loadingMore) return;
    const laneSeenShas = new Set(loadState.entries.map((entry) => entry.sha));
    // load-more shares the load token space with first-page loads so a
    // workspace switch or refresh invalidates any pagination callbacks still
    // in flight, preventing them from appending stale entries to the new list.
    const token = nextLoadToken();
    setLoadState((state) => ({ ...state, loadingMore: true }));
    void loadLogPage({
      workspaceId,
      refName,
      scope: historyScope,
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
  }

  function openMenu(request: HistoryRowMenuRequest): void {
    setMenuTarget({
      entry: request.entry,
      detail: null,
      point: request.point,
    });
  }

  function openCommit(entry: LogEntry): void {
    setSelectedSha(entry.sha);
    openOrRevealCommitTab(workspaceId, entry.sha);
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
            renderRefSlot={(entry, _index, breakpoint) => (
              <RefChipList
                refs={entry.refs}
                currentRefName={refName}
                breakpoint={breakpoint}
                onRefChange={changeHistoryRef}
                onOpenMenu={(event) => {
                  openMenu({ entry, point: { x: event.clientX, y: event.clientY } });
                }}
              />
            )}
            onSelect={(entry) => setSelectedSha(entry.sha)}
            onOpen={openCommit}
            onLoadMore={loadMore}
            onOpenMenu={openMenu}
            onClearSearch={() => setQuery("")}
          />
        </div>
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
  // Per-load dedup. A single page must never contain the same sha twice —
  // any duplicate received from a chunk is dropped before being accumulated
  // or forwarded so React's reconciler never sees duplicate keys.
  const entries: LogEntry[] = [];
  const seenShas = new Set<string>();
  let chunkSeq = 0;
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
      chunkSeq += 1;
      const incoming = chunk.entries.length;
      const uniqueChunk: LogEntry[] = [];
      let duplicatesInPage = 0;
      let duplicatesInChunk = 0;
      const chunkSeen = new Set<string>();
      for (const entry of chunk.entries) {
        if (chunkSeen.has(entry.sha)) {
          duplicatesInChunk += 1;
          continue;
        }
        chunkSeen.add(entry.sha);
        if (seenShas.has(entry.sha)) {
          duplicatesInPage += 1;
          continue;
        }
        seenShas.add(entry.sha);
        uniqueChunk.push(entry);
      }
      console.warn(
        `[history] loadLogPage chunk#${chunkSeq} ws=${workspaceId} scope=${scope} ref=${refName ?? "-"} afterSha=${afterSha ?? "-"} incoming=${incoming} dupInChunk=${duplicatesInChunk} dupAcrossPage=${duplicatesInPage} unique=${uniqueChunk.length} totalUniqueSoFar=${entries.length + uniqueChunk.length}`,
      );
      if (uniqueChunk.length === 0) return;
      entries.push(...uniqueChunk);
      onChunk([...entries], uniqueChunk);
    });
    const complete = await handle.promise;
    if (signal?.aborted) return;
    onComplete(Boolean(complete.hasMore));
  } catch (error) {
    if (signal?.aborted) return;
    onError(messageFromError(error));
  }
}

/** Applies a server-side search result to list state. */
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
