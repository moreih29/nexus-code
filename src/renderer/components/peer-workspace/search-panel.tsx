import { ChevronDown, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../ipc/client";
import type { PeerWorkspaceTarget } from "../../state/stores/peer-workspace";
import { SearchInput } from "../files/search/input";
import { SearchResultsList } from "../files/search/results-list";
import { unsupportedSearchPatternReason } from "../files/search/search-error-text";
import { useGlobalSearchHotkey } from "../files/search/use-global-search-hotkey";
import { validateRegexPattern } from "../files/search/validate-regex-pattern";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
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
  const includes = parsePeerSearchFilters(include, false);
  const excludes = parsePeerSearchFilters(exclude, true);
  const invalidFilters = !includes || !excludes;
  const unsupported = error?.kind === "unsupported";
  const canSearch = canRead && !!query && validation.valid && !invalidFilters && !unsupported;
  useGlobalSearchHotkey(input);
  useEffect(() => {
    if (focusRequest > 0) input.current?.focus();
  }, [focusRequest]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: in-flight results belong to one connection
  useEffect(() => {
    setRunning(false);
    setError((before) => (before?.kind === "unsupported" ? null : before));
    return () => {
      flight.current?.abort();
      flight.current = null;
    };
  }, [canRead, rejoin]);

  function changeSearchCriteria() {
    flight.current?.abort();
    flight.current = null;
    setRunning(false);
    setResults(null);
    if (!unsupported) setError(null);
  }

  function changeQuery(next: string) {
    setQuery(next);
    changeSearchCriteria();
  }

  async function search() {
    if (!canSearch || !includes || !excludes) return;
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
          query,
          caseSensitive: options.isCaseSensitive,
          wholeWord: options.isWordMatch,
          regex: options.isRegExp,
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
            changeSearchCriteria();
            setOptions({ ...options, [key]: !options[key] });
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
                  changeSearchCriteria();
                  setInclude(event.target.value);
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
                  changeSearchCriteria();
                  setExclude(event.target.value);
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
        <p role="status" className="px-2 py-1 text-app-ui-sm text-muted-foreground">
          {errorMessage}
        </p>
      )}
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
        <EmptyState title={files("search.state.noResults")} tone="status" />
      ) : null}
    </div>
  );
}
