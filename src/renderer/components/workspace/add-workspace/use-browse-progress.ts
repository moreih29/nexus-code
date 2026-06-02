import { useCallback, useEffect, useRef, useState } from "react";
import type { SshBrowseProgressEvent } from "../../../../shared/types/workspace";
import { subscribeSshBrowseProgress } from "../../../services/workspace";

export interface BrowseProgressController {
  /** Latest progress event for the active attempt, or null when idle/unstarted. */
  readonly progress: SshBrowseProgressEvent | null;
  /**
   * Begin a new attempt: mints a fresh progressId, clears any prior progress,
   * and returns the id to pass to openSshBrowseSession({ progressId }).
   */
  readonly begin: () => string;
  /** End the attempt: stop accepting events and clear the displayed progress. */
  readonly clear: () => void;
}

/**
 * Tracks SSH browse-session bootstrap progress during a "connect" attempt in
 * the add-workspace dialog.
 *
 * The challenge: the heavy work (agent binary upload/verify) happens inside the
 * openBrowseSession IPC call, before any sessionId/workspaceId exists. So the
 * caller mints a client-side progressId via begin(), passes it to
 * openSshBrowseSession, and this hook filters the broadcast stream by that id.
 *
 * A single subscription lives for the component's lifetime; the active id is
 * held in a ref so events are matched without re-subscribing per attempt.
 */
export function useBrowseProgress(): BrowseProgressController {
  const [progress, setProgress] = useState<SshBrowseProgressEvent | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    const dispose = subscribeSshBrowseProgress((event) => {
      if (event.progressId === activeIdRef.current) {
        setProgress(event);
      }
    });
    return dispose;
  }, []);

  const begin = useCallback((): string => {
    const id = crypto.randomUUID();
    activeIdRef.current = id;
    setProgress(null);
    return id;
  }, []);

  const clear = useCallback((): void => {
    activeIdRef.current = null;
    setProgress(null);
  }, []);

  return { progress, begin, clear };
}
