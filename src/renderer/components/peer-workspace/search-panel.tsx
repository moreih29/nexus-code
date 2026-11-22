import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../ipc/client";
import type { PeerWorkspaceTarget } from "../../state/stores/peer-workspace";
import { SearchInput } from "../files/search/input";
import { SearchResultsList } from "../files/search/results-list";
import { searchErrorText } from "../files/search/search-error-text";
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

export function PeerSearchPanel({
  target,
  canRead,
  rejoin,
}: {
  target: PeerWorkspaceTarget;
  canRead: boolean;
  rejoin: number;
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
  useGlobalSearchHotkey(input);
  useEffect(() => input.current?.focus(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: in-flight results belong to one connection
  useEffect(() => {
    setRunning(false);
    setError((before) => (before?.kind === "unsupported" ? null : before));
    return () => {
      flight.current?.abort();
      flight.current = null;
    };
  }, [canRead, rejoin]);

  function changeQuery(next: string) {
    setQuery(next);
    if (next) return;
    flight.current?.abort();
    flight.current = null;
    setRunning(false);
    setResults(null);
    if (!unsupported) setError(null);
  }

  async function search() {
    if (
      !canRead ||
      !query ||
      !validation.valid ||
      !includes ||
      !excludes ||
      flight.current ||
      unsupported
    )
      return;
    const controller = new AbortController();
    flight.current = controller;
    setRunning(true);
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
      if (reply.ok) setResults(peerSearchResults(reply.value));
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
  const errorMessage = error?.message?.startsWith("Invalid search pattern")
    ? searchErrorText(error.message, files)
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
          onToggleOption={(key) => setOptions({ ...options, [key]: !options[key] })}
          onArrowDown={() => firstRow.current?.()}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          viewModeDisabled={!hasResults}
        />
        <div className="flex items-start justify-between gap-2 px-2 pb-1">
          <details className="min-w-0 flex-1 text-app-ui-sm text-muted-foreground">
            <summary className="cursor-pointer py-1">{t("peerWorkspace.searchFilters")}</summary>
            <label className="mt-1 flex flex-col gap-0.5">
              <span>{t("peerWorkspace.searchInclude")}</span>
              <input
                value={include}
                onChange={(event) => setInclude(event.target.value)}
                placeholder="*.ts, README.md"
                className="min-w-0 rounded border border-border bg-background px-2 py-1 text-app-body text-foreground"
              />
            </label>
            <label className="mt-1 flex flex-col gap-0.5">
              <span>{t("peerWorkspace.searchExclude")}</span>
              <input
                value={exclude}
                onChange={(event) => setExclude(event.target.value)}
                placeholder="fixtures/, *.min.js"
                className="min-w-0 rounded border border-border bg-background px-2 py-1 text-app-body text-foreground"
              />
            </label>
          </details>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            disabled={
              !canRead || !query || running || unsupported || !validation.valid || invalidFilters
            }
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
