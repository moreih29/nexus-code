/**
 * How busy a workspace's host is, or this machine with no workspace named,
 * asked every few seconds while `active` and the window is shown. The last
 * answer for each is kept, so switching back shows it at once. A workspace
 * on another computer is asked the same way (usePolledStats).
 */
import { useEffect, useRef, useState } from "react";
import { ipcCallResult } from "@/ipc/client";
import type { SystemStats } from "../../../shared/system/stats";

export const POLL_MS = 3_000;

/** One ask's answer: the numbers, none now, or "never" from a host that cannot tell at all. */
export type StatsAnswer = SystemStats | null | "never";

const lastFor = new Map<string, SystemStats>();

function useDocumentShown(): boolean {
  // No document while drawn ahead of the window (as tests draw it): nothing asks then.
  const [shown, setShown] = useState(
    () => typeof document !== "undefined" && document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return shown;
}

/**
 * Asks, and again POLL_MS after each answer (so a slow host is not asked
 * on top of itself), until stopped or told "never". Gives the stop, which
 * also aborts an ask still on its way.
 */
export function pollStats(
  ask: (signal: AbortSignal) => Promise<StatsAnswer>,
  tell: (stats: SystemStats | null) => void,
  wait: (next: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const asking = new AbortController();
  const once = async () => {
    const answer = await ask(asking.signal);
    if (!live) return;
    tell(answer === "never" ? null : answer);
    if (answer !== "never") timer = wait(() => void once(), POLL_MS);
  };
  void once();
  return () => {
    live = false;
    clearTimeout(timer);
    asking.abort();
  };
}

/** The numbers `ask` gives for `key`, asked while `active` and the window is shown. */
export function usePolledStats(
  key: string,
  active: boolean,
  ask: (signal: AbortSignal) => Promise<StatsAnswer>,
): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(() => lastFor.get(key) ?? null);
  const shown = useDocumentShown();
  const asking = useRef(ask);
  asking.current = ask;

  useEffect(() => {
    setStats(lastFor.get(key) ?? null);
    if (!active || !shown) return;
    return pollStats(
      (signal) => asking.current(signal),
      (value) => {
        if (value) lastFor.set(key, value);
        else lastFor.delete(key);
        setStats(value);
      },
    );
  }, [key, active, shown]);

  return stats;
}

export function useSystemStats(
  workspaceId: string | undefined,
  active: boolean,
): SystemStats | null {
  return usePolledStats(workspaceId ?? "", active, async (signal) => {
    const result = await ipcCallResult(
      "system",
      "stats",
      workspaceId === undefined ? {} : { workspaceId },
      { signal },
    );
    return result.ok ? result.value : null;
  });
}
