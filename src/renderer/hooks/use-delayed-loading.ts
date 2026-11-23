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
