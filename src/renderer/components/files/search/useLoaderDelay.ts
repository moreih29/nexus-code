/**
 * useLoaderDelay — converts a search status into a delayed `showLoader` boolean.
 *
 * Contract:
 *   - Returns `true` only when `status === "running"` AND the status has been
 *     running for at least `LOADER_DELAY_MS` (250 ms, imported from
 *     SearchStatusHeader so the two values stay in sync).
 *   - When the status transitions away from "running" the boolean resets to
 *     `false` immediately (no trailing visibility).
 *   - The hook owns the `setTimeout` ref internally; the timer is cleared both
 *     on status change and on unmount, so stale state updates never occur.
 *
 * The delay prevents a loader flash for fast searches that complete before
 * the timeout fires.
 */

import { useEffect, useRef, useState } from "react";
import type { SearchStatus } from "../../../state/stores/search";
import { LOADER_DELAY_MS } from "./status-header";

export function useLoaderDelay(status: SearchStatus | undefined): boolean {
  const [showLoader, setShowLoader] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (status === "running") {
      timerRef.current = setTimeout(() => setShowLoader(true), LOADER_DELAY_MS);
    } else {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setShowLoader(false);
    }
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  return showLoader;
}
