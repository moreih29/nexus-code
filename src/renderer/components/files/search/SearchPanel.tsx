/**
 * Search panel — top-level container.
 *
 * Responsibilities:
 *  - Owns input value (local state) + debounce timer (useRef).
 *  - Validates regex when isRegExp is ON, suppresses startSearch on invalid.
 *  - Wires keyboard: Cmd/Ctrl+F → focus+select while panel is mounted.
 *  - Delegates rendering to SearchInput, SearchStatusHeader, SearchResultsList,
 *    and the inline empty/no-results/error states.
 */

import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import {
  EMPTY_SEARCH_OPTIONS,
  type SearchOptions,
  useSearchSession,
  useSearchStore,
} from "../../../state/stores/search";
import { SearchInput } from "./SearchInput";
import { SearchResultsList } from "./SearchResultsList";
import { LOADER_DELAY_MS, SearchStatusHeader } from "./SearchStatusHeader";

const DEBOUNCE_MS = 300;

interface SearchPanelProps {
  workspaceId: string;
}

export function SearchPanel({ workspaceId }: SearchPanelProps) {
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const rootPath = workspace?.rootPath ?? "";

  const [inputValue, setInputValue] = useState("");
  const [options, setOptions] = useState<SearchOptions>({ ...EMPTY_SEARCH_OPTIONS });
  const [regexError, setRegexError] = useState<string | null>(null);

  // Loader: visible only after 250ms of running status.
  const [showLoader, setShowLoader] = useState(false);
  const loaderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const session = useSearchSession(workspaceId);
  const startSearch = useSearchStore((s) => s.startSearch);
  const cancelSearch = useSearchStore((s) => s.cancelSearch);
  const toggleGroup = useSearchStore((s) => s.toggleGroup);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last workspaceId so we cancel timers on workspace switch.
  const prevWorkspaceIdRef = useRef(workspaceId);

  // Cancel debounce and loader timers when workspaceId changes.
  useEffect(() => {
    if (prevWorkspaceIdRef.current !== workspaceId) {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (loaderTimerRef.current !== null) {
        clearTimeout(loaderTimerRef.current);
        loaderTimerRef.current = null;
      }
      setShowLoader(false);
      prevWorkspaceIdRef.current = workspaceId;
    }
  }, [workspaceId]);

  // Cancel debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Loader delay timer — start when status transitions to "running", clear otherwise.
  useEffect(() => {
    if (session?.status === "running") {
      loaderTimerRef.current = setTimeout(() => setShowLoader(true), LOADER_DELAY_MS);
    } else {
      if (loaderTimerRef.current !== null) {
        clearTimeout(loaderTimerRef.current);
        loaderTimerRef.current = null;
      }
      setShowLoader(false);
    }
    return () => {
      if (loaderTimerRef.current !== null) {
        clearTimeout(loaderTimerRef.current);
        loaderTimerRef.current = null;
      }
    };
  }, [session?.status]);

  // Cmd/Ctrl+F handler — focuses + selects the input while panel is mounted.
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  function validateRegex(pattern: string): string | null {
    if (!options.isRegExp) return null;
    try {
      new RegExp(pattern);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  function runSearch(query: string, opts: SearchOptions) {
    if (!query) return;
    const error = opts.isRegExp
      ? (() => {
          try {
            new RegExp(query);
            return null;
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        })()
      : null;
    if (error) {
      setRegexError(error);
      return;
    }
    setRegexError(null);
    startSearch(workspaceId, query, opts);
  }

  function handleChange(value: string) {
    setInputValue(value);

    // Live regex validation
    if (options.isRegExp && value) {
      setRegexError(validateRegex(value));
    } else {
      setRegexError(null);
    }

    // Cancel pending debounce
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }

    if (!value) return;

    // Schedule debounced search
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      runSearch(value, options);
    }, DEBOUNCE_MS);
  }

  function handleEnter() {
    // Cancel pending debounce — Enter fires immediately.
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    runSearch(inputValue, options);
  }

  function handleEsc() {
    if (inputValue) {
      // First Esc: clear value.
      setInputValue("");
      setRegexError(null);
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
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
        const willBeRegex = next.isRegExp;
        if (willBeRegex && inputValue) {
          setRegexError(
            (() => {
              try {
                new RegExp(inputValue);
                return null;
              } catch (err) {
                return err instanceof Error ? err.message : String(err);
              }
            })(),
          );
        } else {
          setRegexError(null);
        }
      }
      // Re-run search with updated options when value present and no error.
      if (inputValue) {
        const error = next.isRegExp
          ? (() => {
              try {
                new RegExp(inputValue);
                return null;
              } catch (err) {
                return err instanceof Error ? err.message : String(err);
              }
            })()
          : null;
        if (!error) {
          // Cancel pending debounce and fire immediately.
          if (debounceTimerRef.current !== null) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
          }
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
