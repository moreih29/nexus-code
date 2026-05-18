/**
 * useSearchDebounce — debounced search dispatch hook.
 *
 * Contract:
 *   - `trigger(value, opts)` cancels any pending timer and schedules a new
 *     one that fires after DEBOUNCE_MS (300 ms). If `value` is empty the
 *     session is dropped via `clearSearch` and no timer is set.
 *   - `flush(value, opts)` cancels any pending timer and dispatches
 *     immediately (used by the Enter key path).
 *   - `cancel()` cancels any pending timer without dispatching (used when
 *     the user clears the input via Esc or the X button).
 *
 * Callers must guard against invalid regex before calling `trigger` or
 * `flush` — these functions call `startSearch` unconditionally when the
 * value is non-empty.
 *
 * The hook owns the debounce `setTimeout` ref internally; the ref is cleaned
 * up on unmount so that stale timers never fire into unmounted components.
 *
 * When `workspaceId` changes the pending timer is cancelled automatically.
 * Callers that also need to cancel the in-flight store request should call
 * `clearSearch` from the store directly.
 */

import { useCallback, useEffect, useRef } from "react";
import { type SearchOptions, useSearchStore } from "../../../state/stores/search";

const DEBOUNCE_MS = 300;

export interface UseSearchDebounceResult {
  /** Schedule a debounced search. Pass empty string to clear instead. */
  trigger: (value: string, opts: SearchOptions) => void;
  /** Cancel any pending debounce and dispatch immediately. */
  flush: (value: string, opts: SearchOptions) => void;
  /** Cancel any pending debounce without dispatching. */
  cancel: () => void;
}

export function useSearchDebounce(workspaceId: string): UseSearchDebounceResult {
  const startSearch = useSearchStore((s) => s.startSearch);
  const clearSearch = useSearchStore((s) => s.clearSearch);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevWorkspaceIdRef = useRef(workspaceId);

  // Cancel pending timer when workspaceId changes.
  useEffect(() => {
    if (prevWorkspaceIdRef.current !== workspaceId) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      prevWorkspaceIdRef.current = workspaceId;
    }
  }, [workspaceId]);

  // Cancel pending timer on unmount.
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
