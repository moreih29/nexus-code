/**
 * usePathAutocomplete — the remote-path combobox behind the SSH directory
 * picker's path input.
 *
 * Owns the autocomplete dropdown concern in isolation: listbox state, the
 * debounced directory listing that backs it, keyboard navigation, and
 * click-outside dismissal. The picker keeps ownership of the main directory
 * list and the path-input value; this hook calls back via `onSelectPath` when
 * the user commits a suggestion.
 */
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirEntry } from "../../../../shared/fs/types";
import { browseSshSession } from "../../../services/workspace";

/** Cache entry — directory listing, shared with the main list + hover prefetch. */
export interface BrowseCacheEntry {
  readonly entries: readonly DirEntry[];
  readonly truncated: boolean;
}

/**
 * Split a path input into its parent directory and the trailing partial
 * segment being typed. `/home/kih/wo` → { dir: "/home/kih", partial: "wo" };
 * `/home/kih/` → { dir: "/home/kih", partial: "" }.
 */
function splitPathInput(input: string): { dir: string; partial: string } {
  const idx = input.lastIndexOf("/");
  if (idx < 0) return { dir: "", partial: input };
  return { dir: idx === 0 ? "/" : input.slice(0, idx), partial: input.slice(idx + 1) };
}

/** Join a parent directory and a child segment into a POSIX path. */
function joinSegment(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export interface UsePathAutocompleteParams {
  readonly sessionId: string;
  /** Current value of the path input. */
  readonly pathInput: string;
  /** Shared browse cache (also populated by the main list + hover prefetch). */
  readonly browseCache: React.RefObject<Map<string, BrowseCacheEntry>>;
  /**
   * Called when the user commits a suggestion. Receives the resolved absolute
   * path; the caller updates the path input + navigates the main list.
   */
  readonly onSelectPath: (targetPath: string) => void;
}

export interface UsePathAutocomplete {
  readonly suggestionsOpen: boolean;
  readonly activeSuggestionIndex: number;
  readonly filteredSuggestions: readonly DirEntry[];
  readonly suggestionsDirLoading: boolean;
  readonly comboboxRef: React.RefObject<HTMLDivElement | null>;
  readonly activeOptionRef: React.RefObject<HTMLButtonElement | null>;
  /** Open the dropdown + reset the highlight — call from the input's onChange. */
  readonly handleInputChange: () => void;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Commit a suggestion entry (used by option click + Enter). */
  readonly selectSuggestion: (entry: DirEntry) => void;
  /** Close the dropdown — call from folder clicks / path submit. */
  readonly closeSuggestions: () => void;
}

export function usePathAutocomplete({
  sessionId,
  pathInput,
  browseCache,
  onSelectPath,
}: UsePathAutocompleteParams): UsePathAutocomplete {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [suggestionDir, setSuggestionDir] = useState("");
  const [suggestionEntries, setSuggestionEntries] = useState<readonly DirEntry[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);

  // Suggestion listing — fetches the directory whose children populate the
  // dropdown. Kept separate from the picker's loadPath so it never disturbs
  // the main list or currentPath.
  const loadSuggestions = useCallback(
    async (dir: string, abortSignal: AbortSignal): Promise<void> => {
      const cached = browseCache.current.get(dir);
      if (cached) {
        setSuggestionDir(dir);
        setSuggestionEntries(cached.entries);
        setSuggestionsLoading(false);
        return;
      }

      setSuggestionsLoading(true);
      try {
        const result = await browseSshSession(sessionId, dir);
        if (abortSignal.aborted) return;
        browseCache.current.set(dir, { entries: result.entries, truncated: result.truncated });
        setSuggestionDir(dir);
        setSuggestionEntries(result.entries);
      } catch {
        if (abortSignal.aborted) return;
        // Directory missing or not listable — surface no completions.
        setSuggestionDir(dir);
        setSuggestionEntries([]);
      } finally {
        if (!abortSignal.aborted) setSuggestionsLoading(false);
      }
    },
    [sessionId, browseCache],
  );

  const { dir: inputDir, partial: inputPartial } = useMemo(
    () => splitPathInput(pathInput),
    [pathInput],
  );

  // Dropdown entries: children of the typed parent directory, filtered by the
  // partial segment. Empty while a fetch for a newly-entered directory is in
  // flight (suggestionDir lags inputDir).
  const filteredSuggestions = useMemo<readonly DirEntry[]>(() => {
    if (suggestionDir !== inputDir) return [];
    const needle = inputPartial.toLowerCase();
    return suggestionEntries.filter((entry) => entry.name.toLowerCase().startsWith(needle));
  }, [suggestionEntries, suggestionDir, inputDir, inputPartial]);

  const suggestionsDirLoading = suggestionsLoading || suggestionDir !== inputDir;

  // Fetch the listing that backs the dropdown whenever the typed parent
  // directory changes. Cache hits make same-directory keystrokes instant, so
  // only crossing a "/" boundary triggers a network request.
  useEffect(() => {
    if (!suggestionsOpen || suggestionDir === inputDir) return;
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    void loadSuggestions(inputDir, controller.signal);
    return () => controller.abort();
  }, [suggestionsOpen, inputDir, suggestionDir, loadSuggestions]);

  // Keep a valid option highlighted as the filtered list changes. The first
  // entry is auto-selected (index 0) so pressing Enter commits the top match
  // without first arrowing down; only an empty list clears the highlight.
  useEffect(() => {
    setActiveSuggestionIndex((cur) => {
      if (filteredSuggestions.length === 0) return -1;
      return Math.min(Math.max(cur, 0), filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions.length]);

  // Scroll the highlighted option into view during keyboard navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs on highlight change
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeSuggestionIndex]);

  // Close the dropdown on a click outside the combobox.
  useEffect(() => {
    if (!suggestionsOpen) return;
    function handlePointerDown(event: PointerEvent): void {
      if (comboboxRef.current && !comboboxRef.current.contains(event.target as Node)) {
        setSuggestionsOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [suggestionsOpen]);

  const closeSuggestions = useCallback((): void => {
    setSuggestionsOpen(false);
  }, []);

  // Select an autocomplete entry: hand the resolved folder path to the caller
  // (which moves the main list + appends a trailing slash so the dropdown keeps
  // drilling into its children). The dropdown stays open by design.
  const selectSuggestion = useCallback(
    (entry: DirEntry): void => {
      const targetPath = joinSegment(inputDir, entry.name);
      setActiveSuggestionIndex(-1);
      onSelectPath(targetPath);
    },
    [inputDir, onSelectPath],
  );

  const handleInputChange = useCallback((): void => {
    setSuggestionsOpen(true);
    // Reset the highlight to the top match on every keystroke; the range
    // effect demotes this to -1 when the new partial filters out every entry.
    setActiveSuggestionIndex(0);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (filteredSuggestions.length === 0) return;
        setSuggestionsOpen(true);
        setActiveSuggestionIndex((cur) => (cur + 1) % filteredSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (filteredSuggestions.length === 0) return;
        setSuggestionsOpen(true);
        setActiveSuggestionIndex((cur) => (cur <= 0 ? filteredSuggestions.length - 1 : cur - 1));
        return;
      }
      if (event.key === "Enter" && suggestionsOpen && activeSuggestionIndex >= 0) {
        const entry = filteredSuggestions[activeSuggestionIndex];
        if (entry) {
          event.preventDefault();
          selectSuggestion(entry);
        }
        return;
      }
      if (event.key === "Escape" && suggestionsOpen) {
        event.preventDefault();
        setSuggestionsOpen(false);
      }
    },
    [filteredSuggestions, suggestionsOpen, activeSuggestionIndex, selectSuggestion],
  );

  return {
    suggestionsOpen,
    activeSuggestionIndex,
    filteredSuggestions,
    suggestionsDirLoading,
    comboboxRef,
    activeOptionRef,
    handleInputChange,
    handleKeyDown,
    selectSuggestion,
    closeSuggestions,
  };
}
