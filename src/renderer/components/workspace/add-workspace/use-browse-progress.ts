import { useCallback, useEffect, useRef, useState } from "react";
import type { SshBrowseProgressEvent } from "../../../../shared/types/workspace";
import { subscribeSshBrowseProgress } from "../../../services/workspace";

export interface BrowseProgressController {
  readonly progress: SshBrowseProgressEvent | null;
  readonly begin: () => string;
  readonly clear: () => void;
}

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
