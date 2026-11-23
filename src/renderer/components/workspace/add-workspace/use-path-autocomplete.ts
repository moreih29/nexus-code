import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isImeComposing } from "@/utils/ime";
import type { DirEntry } from "../../../../shared/fs/types";
import { browseSshSession } from "../../../services/workspace";

export interface BrowseCacheEntry {
  readonly entries: readonly DirEntry[];
  readonly truncated: boolean;
}

function splitPathInput(input: string): { dir: string; partial: string } {
  const idx = input.lastIndexOf("/");
  if (idx < 0) return { dir: "", partial: input };
  return { dir: idx === 0 ? "/" : input.slice(0, idx), partial: input.slice(idx + 1) };
}

function joinSegment(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export interface UsePathAutocompleteParams {
  readonly sessionId: string;
  readonly pathInput: string;
  readonly browseCache: React.RefObject<Map<string, BrowseCacheEntry>>;
  readonly onSelectPath: (targetPath: string) => void;
}

export interface UsePathAutocomplete {
  readonly suggestionsOpen: boolean;
  readonly activeSuggestionIndex: number;
  readonly filteredSuggestions: readonly DirEntry[];
  readonly suggestionsDirLoading: boolean;
  readonly comboboxRef: React.RefObject<HTMLDivElement | null>;
  readonly activeOptionRef: React.RefObject<HTMLButtonElement | null>;
  readonly handleInputChange: () => void;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly selectSuggestion: (entry: DirEntry) => void;
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
        if (result.ok) browseCache.current.set(dir, result.value);
        setSuggestionDir(dir);
        setSuggestionEntries(result.ok ? result.value.entries : []);
      } catch {
        if (abortSignal.aborted) return;
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

  const filteredSuggestions = useMemo<readonly DirEntry[]>(() => {
    if (suggestionDir !== inputDir) return [];
    const needle = inputPartial.toLowerCase();
    return suggestionEntries.filter((entry) => entry.name.toLowerCase().startsWith(needle));
  }, [suggestionEntries, suggestionDir, inputDir, inputPartial]);

  const suggestionsDirLoading = suggestionsLoading || suggestionDir !== inputDir;

  useEffect(() => {
    if (!suggestionsOpen || suggestionDir === inputDir) return;
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    void loadSuggestions(inputDir, controller.signal);
    return () => controller.abort();
  }, [suggestionsOpen, inputDir, suggestionDir, loadSuggestions]);

  useEffect(() => {
    setActiveSuggestionIndex((cur) => {
      if (filteredSuggestions.length === 0) return -1;
      return Math.min(Math.max(cur, 0), filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs on highlight change
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeSuggestionIndex]);

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
    setActiveSuggestionIndex(0);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (isImeComposing(event)) return;
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
