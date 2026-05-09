/**
 * Search panel — top-level container.
 *
 * Responsibilities:
 *  - Owns input value (local state) + regex-error state.
 *  - Validates regex via validateRegexPattern; suppresses startSearch on invalid.
 *  - Wires keyboard: Cmd/Ctrl+F → focus+select while panel is mounted
 *    (via useGlobalSearchHotkey).
 *  - Debounces search dispatch via useSearchDebounce.
 *  - Converts running status to delayed loader visibility via useLoaderDelay.
 *  - Delegates rendering to SearchInput, SearchStatusHeader, SearchResultsList,
 *    and the inline empty/no-results/error states.
 */

import { CircleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import {
  EMPTY_SEARCH_OPTIONS,
  type SearchOptions,
  useSearchSession,
  useSearchStore,
} from "../../../state/stores/search";
import { SearchInput } from "./SearchInput";
import { SearchResultsList } from "./SearchResultsList";
import { SearchStatusHeader } from "./SearchStatusHeader";
import { useGlobalSearchHotkey } from "./useGlobalSearchHotkey";
import { useLoaderDelay } from "./useLoaderDelay";
import { useSearchDebounce } from "./useSearchDebounce";
import { validateRegexPattern } from "./validateRegexPattern";

interface SearchPanelProps {
  workspaceId: string;
}

export function SearchPanel({ workspaceId }: SearchPanelProps) {
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const rootPath = workspace?.rootPath ?? "";

  const [inputValue, setInputValue] = useState("");
  const [options, setOptions] = useState<SearchOptions>({ ...EMPTY_SEARCH_OPTIONS });
  const [regexError, setRegexError] = useState<string | null>(null);

  const session = useSearchSession(workspaceId);
  const startSearch = useSearchStore((s) => s.startSearch);
  const cancelSearch = useSearchStore((s) => s.cancelSearch);
  const clearSearch = useSearchStore((s) => s.clearSearch);
  const toggleGroup = useSearchStore((s) => s.toggleGroup);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const { trigger, flush, cancel } = useSearchDebounce(workspaceId);
  const showLoader = useLoaderDelay(session?.status);
  useGlobalSearchHotkey(inputRef);

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

    // Live regex validation.
    if (options.isRegExp && value) {
      const result = validateRegexPattern(value, true);
      setRegexError(result.valid ? null : result.error);
    } else {
      setRegexError(null);
    }

    // Suppress debounced dispatch when regex is invalid.
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
    runSearch(inputValue, options);
    // flush is not used here because runSearch already calls startSearch
    // directly and handles regex validation; trigger/flush are for the
    // debounce path only.
  }

  function handleEsc() {
    if (inputValue) {
      // First Esc: clear value AND drop the session — same semantics as the
      // X button or backspacing to empty.
      setInputValue("");
      setRegexError(null);
      cancel();
      clearSearch(workspaceId);
    } else {
      // Second Esc (empty value): blur.
      inputRef.current?.blur();
    }
  }

  function handleToggleOption(
    key: keyof Pick<SearchOptions, "isCaseSensitive" | "isWordMatch" | "isRegExp">,
  ) {
    setOptions((prev) => {
      const next = { ...prev, [key]: !prev[key] };

      // Re-validate regex with toggled state.
      if (key === "isRegExp") {
        if (next.isRegExp && inputValue) {
          const result = validateRegexPattern(inputValue, true);
          setRegexError(result.valid ? null : result.error);
        } else {
          setRegexError(null);
        }
      }

      // Re-run search with updated options when value present and no error.
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

  // ---- Render states ----

  // isEmpty: no active search — no local input AND no session with a query.
  const hasActiveQuery = inputValue.length > 0 || (session != null && session.query.length > 0);
  const isEmpty = !hasActiveQuery;
  const isError = session?.status === "error";
  const isNoResults = hasActiveQuery && session?.status === "done" && session.results.length === 0;
  const hasResults = session && session.results.length > 0;

  return (
    <div className="flex flex-col h-full">
      <SearchInput
        inputRef={inputRef}
        value={inputValue}
        options={options}
        regexError={regexError}
        onChange={handleChange}
        onEnter={handleEnter}
        onEsc={handleEsc}
        onToggleOption={handleToggleOption}
      />

      {session && (session.status === "running" || session.status === "done") && (
        <SearchStatusHeader
          session={session}
          showLoader={showLoader}
          onCancel={() => cancelSearch(workspaceId)}
        />
      )}

      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {isEmpty && (
          <p className="px-4 py-4 text-app-ui-sm text-muted-foreground text-center">
            Search across workspace
          </p>
        )}

        {isError && session && (
          <div className="px-4 py-4 flex flex-col items-center gap-2">
            <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
            <p className="text-app-ui-sm text-muted-foreground text-center">
              {session.errorMessage ?? "Search failed"}
            </p>
            <button
              type="button"
              className="text-app-ui-sm text-primary underline underline-offset-2"
              onClick={() => runSearch(inputValue, options)}
            >
              Retry
            </button>
          </div>
        )}

        {isNoResults && (
          <div className="px-4 py-4 text-center flex flex-col gap-1">
            <p className="text-app-ui-sm text-foreground">No results found</p>
            <p className="text-app-ui-sm text-muted-foreground">Try a different search term.</p>
          </div>
        )}

        {hasResults && session && (
          <SearchResultsList
            workspaceId={workspaceId}
            rootPath={rootPath}
            results={session.results}
            onToggleGroup={(relPath) => toggleGroup(workspaceId, relPath)}
          />
        )}
      </div>
    </div>
  );
}
