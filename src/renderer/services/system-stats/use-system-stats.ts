/**
 * How busy a workspace's host is, or this machine with no workspace named,
 * asked every few seconds while `active` and the window is shown. The last
 * answer for each is kept, so switching back shows it at once.
 */
import { useEffect, useState } from "react";
import { ipcCallResult } from "@/ipc/client";
import type { SystemStats } from "../../../shared/system/stats";

export const POLL_MS = 3_000;

const lastFor = new Map<string, SystemStats>();

function useDocumentShown(): boolean {
  const [shown, setShown] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return shown;
}

export function useSystemStats(
  workspaceId: string | undefined,
  active: boolean,
): SystemStats | null {
  const key = workspaceId ?? "";
  const [stats, setStats] = useState<SystemStats | null>(() => lastFor.get(key) ?? null);
  const shown = useDocumentShown();

  useEffect(() => {
    setStats(lastFor.get(key) ?? null);
    if (!active || !shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const result = await ipcCallResult(
        "system",
        "stats",
        workspaceId === undefined ? {} : { workspaceId },
      );
      if (!live) return;
      const value = result.ok ? result.value : null;
      if (value) lastFor.set(key, value);
      else lastFor.delete(key);
      setStats(value);
      // The next ask waits for this one, so a slow host is not asked on top of itself.
      timer = setTimeout(ask, POLL_MS);
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, workspaceId, active, shown]);

  return stats;
}
