import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealEditorAt } from "@/services/editor/tabs";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import type { SearchRange } from "../../../../shared/search/types";
import type { ViewMode } from "../../../../shared/types/panel";
import { usePanelViewOptionsStore, useViewOptions } from "../../../state/stores/panel-view-options";
import {
  EMPTY_SEARCH_OPTIONS,
  type SearchOptions,
  useSearchSession,
  useSearchStore,
} from "../../../state/stores/search";
import { shouldHandleArrowDown } from "./arrow-down-handoff";
import { SearchInput } from "./input";
import { SearchResultsList } from "./results-list";
import { searchErrorText } from "./search-error-text";
import { SearchFailedMessage, SearchIdleMessage, SearchNoResultsMessage } from "./state-messages";
import { SearchStatusHeader } from "./status-header";
import { useGlobalSearchHotkey } from "./use-global-search-hotkey";
import { useLoaderDelay } from "./use-loader-delay";
import { useSearchDebounce } from "./use-search-debounce";
import { validateRegexPattern } from "./validate-regex-pattern";

interface SearchPanelProps {
  workspaceId: string;
  focusRequest?: number;
}

const EMPTY_EXPANDED_DIRS: ReadonlySet<string> = new Set<string>();

export function SearchPanel({ workspaceId, focusRequest = 0 }: SearchPanelProps) {
  const { t } = useTranslation("files");
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const rootPath = workspace?.rootPath ?? "";

  const [inputValue, setInputValue] = useState(
    () => useSearchStore.getState().sessions.get(workspaceId)?.query ?? "",
  );
  const [options, setOptions] = useState<SearchOptions>(() => ({
    ...(useSearchStore.getState().sessions.get(workspaceId)?.options ?? EMPTY_SEARCH_OPTIONS),
  }));
  const [regexError, setRegexError] = useState<string | null>(null);

  const session = useSearchSession(workspaceId);
  const startSearch = useSearchStore((s) => s.startSearch);
  const cancelSearch = useSearchStore((s) => s.cancelSearch);
  const clearSearch = useSearchStore((s) => s.clearSearch);
  const toggleGroup = useSearchStore((s) => s.toggleGroup);
  const toggleExpandedDir = useSearchStore((s) => s.toggleExpandedDir);
  const expandedDirs = useSearchStore(
    (s) => s.expandedDirsByWorkspace.get(workspaceId) ?? EMPTY_EXPANDED_DIRS,
  );

  const loadViewOptions = usePanelViewOptionsStore((s) => s.loadViewOptions);
  const setViewMode = usePanelViewOptionsStore((s) => s.setViewMode);
  const viewState = useViewOptions("search", workspaceId);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const firstRowFocusRef = useRef<(() => void) | null>(null);
  const { trigger, cancel } = useSearchDebounce(workspaceId);
  const showLoader = useLoaderDelay(session?.status);
  useGlobalSearchHotkey(inputRef);

  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    loadViewOptions("search", workspaceId);
  }, [workspaceId, loadViewOptions]);

  const [liveText, setLiveText] = useState("");
  const prevStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const status = session?.status;
    if (status === "done" && prevStatusRef.current === "running") {
      const matchCount = session?.matchesFound ?? 0;
      const fileCount = session?.results.length ?? 0;
      setLiveText(t("search.liveRegion.results", { count: matchCount, fileCount }));
    }
    prevStatusRef.current = status;
  }, [session?.status, session?.matchesFound, session?.results.length, t]);

  function runSearch(query: string, opts: SearchOptions) {
    if (!query) return;
    const result = validateRegexPattern(query, opts.isRegExp);
    if (!result.valid) {
      setRegexError(result.error);
      return;
    }
    setRegexError(null);
    startSearch(workspaceId, query, opts);
  }

  function handleChange(value: string) {
    setInputValue(value);

    if (options.isRegExp && value) {
      const result = validateRegexPattern(value, true);
      setRegexError(result.valid ? null : result.error);
    } else {
      setRegexError(null);
    }

    if (options.isRegExp && value) {
      const result = validateRegexPattern(value, true);
      if (!result.valid) {
        cancel();
        return;
      }
    }

    trigger(value, options);
  }

  function handleEnter() {
    cancel();
    runSearch(inputValue, options);
  }

  function handleEsc() {
    if (inputValue) {
      setInputValue("");
      setRegexError(null);
      cancel();
      clearSearch(workspaceId);
    } else {
      inputRef.current?.blur();
    }
  }

  function handleToggleOption(
    key: keyof Pick<SearchOptions, "isCaseSensitive" | "isWordMatch" | "isRegExp">,
  ) {
    setOptions((prev) => {
      const next = { ...prev, [key]: !prev[key] };

      if (key === "isRegExp") {
        if (next.isRegExp && inputValue) {
          const result = validateRegexPattern(inputValue, true);
          setRegexError(result.valid ? null : result.error);
        } else {
          setRegexError(null);
        }
      }

      if (inputValue) {
        const result = validateRegexPattern(inputValue, next.isRegExp);
        if (result.valid) {
          cancel();
          startSearch(workspaceId, inputValue, next);
        }
      }

      return next;
    });
  }

  function handleInputArrowDown() {
    if (!shouldHandleArrowDown(session)) return;
    inputRef.current?.blur();
    firstRowFocusRef.current?.();
  }

  const handleOpenMatch = useCallback(
    (relPath: string, range: SearchRange) => {
      const filePath = rootPath.endsWith("/") ? `${rootPath}${relPath}` : `${rootPath}/${relPath}`;
      revealEditorAt(
        { workspaceId, filePath },
        {
          selection: {
            startLineNumber: range.line + 1,
            startColumn: range.startCol + 1,
            endLineNumber: range.line + 1,
            endColumn: range.endCol + 1,
          },
        },
      );
    },
    [rootPath, workspaceId],
  );

  const hasActiveQuery = inputValue.length > 0 || (session != null && session.query.length > 0);
  const isEmpty = !hasActiveQuery;
  const isError = session?.status === "error";
  const isNoResults = hasActiveQuery && session?.status === "done" && session.results.length === 0;
  const hasResults = session && session.results.length > 0;

  return (
    <div className="flex flex-col h-full">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveText}
      </div>

      <SearchInput
        inputRef={inputRef}
        value={inputValue}
        options={options}
        regexError={regexError}
        onChange={handleChange}
        onEnter={handleEnter}
        onEsc={handleEsc}
        onToggleOption={handleToggleOption}
        onArrowDown={handleInputArrowDown}
        viewMode={viewState.viewMode}
        onViewModeChange={(next: ViewMode) => setViewMode("search", workspaceId, next)}
        viewModeDisabled={!hasResults}
      />

      {session && (session.status === "running" || session.status === "done") && (
        <SearchStatusHeader
          session={session}
          showLoader={showLoader}
          onCancel={() => cancelSearch(workspaceId)}
        />
      )}

      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {isEmpty && <SearchIdleMessage />}

        {isError && session && (
          <SearchFailedMessage
            message={searchErrorText(session.errorMessage, t)}
            onRetry={() => runSearch(inputValue, options)}
          />
        )}

        {isNoResults && <SearchNoResultsMessage />}

        {hasResults && session && (
          <SearchResultsList
            onOpenMatch={handleOpenMatch}
            results={session.results}
            onToggleGroup={(relPath) => toggleGroup(workspaceId, relPath)}
            viewMode={viewState.viewMode}
            expandedDirs={expandedDirs}
            onToggleDir={(relPath) => toggleExpandedDir(workspaceId, relPath)}
            firstRowFocusRef={firstRowFocusRef}
          />
        )}
      </div>
    </div>
  );
}
