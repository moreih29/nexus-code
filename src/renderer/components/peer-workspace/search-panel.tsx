import { ChevronDown, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../ipc/client";
import type { PeerWorkspaceTarget } from "../../state/stores/peer-workspace";
import { SearchInput } from "../files/search/input";
import { SearchResultsList } from "../files/search/results-list";
import { unsupportedSearchPatternReason } from "../files/search/search-error-text";
import {
  SearchFailedMessage,
  SearchIdleMessage,
  SearchNoResultsMessage,
} from "../files/search/state-messages";
import { useGlobalSearchHotkey } from "../files/search/use-global-search-hotkey";
import { validateRegexPattern } from "../files/search/validate-regex-pattern";
import { Button } from "../ui/button";
import {
  markMissingPeer,
  openPeerResult,
  parsePeerSearchFilters,
  peerSearchErrorKey,
  peerSearchResults,
} from "./search-model";

const INITIAL_OPTIONS = {
  isCaseSensitive: false,
  isRegExp: false,
  isWordMatch: false,
  includes: [],
  excludes: [],
};

const PATTERN_REASON_LIMIT = 256;

/**
 * How long typing pauses before the search runs, as the local panel's 300ms
 * but a little longer: each search runs on the other computer, and one that
 * typing overtakes is only dropped here, not stopped there.
 */
export const PEER_SEARCH_DEBOUNCE_MS = 400;

/** What a search looks for: the text, its options and the two filters. */
interface SearchCriteria {
  query: string;
  options: typeof INITIAL_OPTIONS;
  include: string;
  exclude: string;
}

export function PeerSearchPanel({
  target,
  canRead,
  rejoin,
  focusRequest = 0,
}: {
  target: PeerWorkspaceTarget;
  canRead: boolean;
  rejoin: number;
  /** Bumped by each click on the Search button: the input takes the keyboard. */
  focusRequest?: number;
}) {
  const { t } = useTranslation();
  const { t: files } = useTranslation("files");
  const input = useRef<HTMLInputElement>(null);
  const firstRow = useRef<(() => void) | null>(null);
  const flight = useRef<AbortController | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState(INITIAL_OPTIONS);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReturnType<typeof peerSearchResults> | null>(null);
  const [error, setError] = useState<{ kind: string; message?: string } | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "tree">("list");
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const validation = validateRegexPattern(query, options.isRegExp);
  const invalidFilters =
    !parsePeerSearchFilters(include, false) || !parsePeerSearchFilters(exclude, true);
  const unsupported = error?.kind === "unsupported";
  const current: SearchCriteria = { query, options, include, exclude };
  const canSearch = searchable(current);
  useGlobalSearchHotkey(input);
  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: in-flight and pending searches belong to one connection and workspace
  useEffect(() => {
    setRunning(false);
    setError((before) => (before?.kind === "unsupported" ? null : before));
    return () => {
      cancelPending();
      flight.current?.abort();
      flight.current = null;
    };
  }, [canRead, rejoin, target.deviceId, target.workspaceId]);

  function cancelPending() {
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = null;
  }

  function searchable(criteria: SearchCriteria): boolean {
    return (
      canRead &&
      !!criteria.query &&
      validateRegexPattern(criteria.query, criteria.options.isRegExp).valid &&
      !!parsePeerSearchFilters(criteria.include, false) &&
      !!parsePeerSearchFilters(criteria.exclude, true) &&
      !unsupported
    );
  }

  /**
   * A change to what is searched for: the results so far, and a search still
   * running, are dropped; the search runs again once typing pauses, or at
   * once for an option, as locally.
   */
  function changeSearchCriteria(next: Partial<SearchCriteria>, at: "pause" | "once" = "pause") {
    cancelPending();
    flight.current?.abort();
    flight.current = null;
    setRunning(false);
    setResults(null);
    if (!unsupported) setError(null);
    const criteria = { ...current, ...next };
    if (!searchable(criteria)) return;
    if (at === "once") void search(criteria);
    else pending.current = setTimeout(() => void search(criteria), PEER_SEARCH_DEBOUNCE_MS);
  }

  function changeQuery(next: string) {
    setQuery(next);
    changeSearchCriteria({ query: next });
  }

  async function search(criteria: SearchCriteria = current) {
    cancelPending();
    const includes = parsePeerSearchFilters(criteria.include, false);
    const excludes = parsePeerSearchFilters(criteria.exclude, true);
    if (!searchable(criteria) || !includes || !excludes) return;
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    setRunning(true);
    setResults(null);
    setError(null);
    const { signal } = controller;
    try {
      const reply = await ipcCallResult(
        "remote",
        "peerFilesSearch",
        {
          deviceId: target.deviceId,
          workspaceId: target.workspaceId,
          query: criteria.query,
          caseSensitive: criteria.options.isCaseSensitive,
          wholeWord: criteria.options.isWordMatch,
          regex: criteria.options.isRegExp,
          include: includes,
          exclude: excludes,
        },
        { signal },
      );
      if (signal.aborted) return;
      if (reply.ok) setResults(peerSearchResults(target.workspace.path, reply.value));
      else if (reply.kind === "not-found") markMissingPeer(target);
      else setError({ kind: reply.kind, message: reply.message });
    } catch {
      if (!signal.aborted) setError({ kind: "unavailable" });
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        setRunning(false);
      }
    }
  }

  const hasResults = !!results?.groups.length;
  const reason =
    error?.kind === "unavailable" && error.message && unsupportedSearchPatternReason(error.message);
  const errorMessage = reason
    ? files("search.unsupportedRegex", {
        error:
          reason.length > PATTERN_REASON_LIMIT
            ? `${reason.slice(0, PATTERN_REASON_LIMIT - 1)}…`
            : reason,
      })
    : error && t(peerSearchErrorKey(error.kind));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <SearchInput
          inputRef={input}
          value={query}
          maxLength={1024}
          options={options}
          regexError={validation.valid ? null : validation.error}
          onChange={changeQuery}
          onEnter={() => void search()}
          onEsc={() => {
            if (query) changeQuery("");
            else input.current?.blur();
          }}
          onToggleOption={(key) => {
            const next = { ...options, [key]: !options[key] };
            setOptions(next);
            changeSearchCriteria({ options: next }, "once");
          }}
          onArrowDown={() => firstRow.current?.()}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          viewModeDisabled={!hasResults}
        />
        <div className="flex flex-col gap-1 px-2 pb-1">
          <details className="group min-w-0 text-app-ui-sm text-muted-foreground">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 py-1 whitespace-nowrap [&::-webkit-details-marker]:hidden">
              {t("peerWorkspace.searchFilters")}
              <ChevronDown
                aria-hidden="true"
                className="size-3 shrink-0 transition-transform group-open:rotate-180"
              />
            </summary>
            <label className="mt-1 flex flex-col gap-0.5">
              <span>{t("peerWorkspace.searchInclude")}</span>
              <input
                value={include}
                onChange={(event) => {
                  setInclude(event.target.value);
                  changeSearchCriteria({ include: event.target.value });
                }}
                placeholder="*.ts, README.md"
                className="min-w-0 rounded border border-border bg-background px-2 py-1 text-app-body text-foreground"
              />
            </label>
            <label className="mt-1 flex flex-col gap-0.5">
              <span>{t("peerWorkspace.searchExclude")}</span>
              <input
                value={exclude}
                onChange={(event) => {
                  setExclude(event.target.value);
                  changeSearchCriteria({ exclude: event.target.value });
                }}
                placeholder="fixtures/, *.min.js"
                className="min-w-0 rounded border border-border bg-background px-2 py-1 text-app-body text-foreground"
              />
            </label>
          </details>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="self-end"
            disabled={!canSearch}
          >
            <Search aria-hidden="true" />
            {t("files:panel.tab.search")}
          </Button>
        </div>
      </form>
      {invalidFilters && (
        <p role="alert" className="px-2 py-1 text-app-ui-sm text-destructive">
          {t("peerWorkspace.searchInvalidFilters")}
        </p>
      )}
      {running && (
        <p role="status" className="px-2 py-1 text-app-ui-sm text-muted-foreground">
          {t("palette.searching")}
        </p>
      )}
      {errorMessage && canRead && (
        <SearchFailedMessage
          message={errorMessage}
          // A computer that cannot search this way says so again on a retry.
          onRetry={unsupported ? undefined : () => void search()}
        />
      )}
      {!query && !results && !running && !error && !invalidFilters && <SearchIdleMessage />}
      {results && (
        <div className="px-2 py-1 text-app-ui-sm text-muted-foreground" role="status">
          {files("search.status.results", {
            count: results.matchesFound,
            fileCount: results.groups.length,
          })}
          {results.truncated && <div>{t("peerWorkspace.searchTruncated")}</div>}
        </div>
      )}
      {results && hasResults ? (
        <SearchResultsList
          results={results.groups}
          onOpenMatch={(relative, range) => openPeerResult(target, relative, canRead, range)}
          onToggleGroup={(path) =>
            setResults({
              ...results,
              groups: results.groups.map((group) =>
                group.relPath === path ? { ...group, expanded: !group.expanded } : group,
              ),
            })
          }
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          onToggleDir={(path) =>
            setExpandedDirs((before) => {
              const next = new Set(before);
              if (!next.delete(path)) next.add(path);
              return next;
            })
          }
          firstRowFocusRef={firstRow}
        />
      ) : results && !running && !error ? (
        <SearchNoResultsMessage />
      ) : null}
    </div>
  );
}
