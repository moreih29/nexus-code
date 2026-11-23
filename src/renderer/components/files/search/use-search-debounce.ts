import { useCallback, useEffect, useRef } from "react";
import { type SearchOptions, useSearchStore } from "../../../state/stores/search";

const DEBOUNCE_MS = 300;

export interface UseSearchDebounceResult {
  trigger: (value: string, opts: SearchOptions) => void;
  flush: (value: string, opts: SearchOptions) => void;
  cancel: () => void;
}

export function useSearchDebounce(workspaceId: string): UseSearchDebounceResult {
  const startSearch = useSearchStore((s) => s.startSearch);
  const clearSearch = useSearchStore((s) => s.clearSearch);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevWorkspaceIdRef = useRef(workspaceId);

  useEffect(() => {
    if (prevWorkspaceIdRef.current !== workspaceId) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      prevWorkspaceIdRef.current = workspaceId;
    }
  }, [workspaceId]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const trigger = useCallback(
    (value: string, opts: SearchOptions) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (!value) {
        clearSearch(workspaceId);
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        startSearch(workspaceId, value, opts);
      }, DEBOUNCE_MS);
    },
    [workspaceId, startSearch, clearSearch],
  );

  const flush = useCallback(
    (value: string, opts: SearchOptions) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!value) return;
      startSearch(workspaceId, value, opts);
    },
    [workspaceId, startSearch],
  );

  return { trigger, flush, cancel };
}
