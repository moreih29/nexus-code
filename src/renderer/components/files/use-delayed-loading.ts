/**
 * Hide a loading indicator until the load has been pending for at
 * least `delayMs`. Below the threshold, fast IPC round-trips finish
 * without ever flashing the spinner — the well-known "skeleton vs
 * flash" UX threshold.
 *
 * The hook resets to `false` the instant `isLoading` flips off so a
 * flicker between two quick loads doesn't leave a stale spinner.
 */

import { useEffect, useState } from "react";

export function useDelayedLoading(isLoading: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [isLoading, delayMs]);

  return shown;
}
