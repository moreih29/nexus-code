import { useEffect, useRef, useState } from "react";
import { ipcCallResult } from "@/ipc/client";
import type { SystemStats } from "../../../shared/system/stats";

export const POLL_MS = 3_000;

export type StatsAnswer = SystemStats | null | "never";

const lastFor = new Map<string, SystemStats>();

export function rememberStats(key: string, stats: SystemStats | null): void {
  if (stats) lastFor.set(key, stats);
  else lastFor.delete(key);
}

export function rememberedStats(key: string): SystemStats | null {
  return lastFor.get(key) ?? null;
}

function useDocumentShown(): boolean {
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

export function usePolledStats(
  key: string,
  active: boolean,
  ask: (signal: AbortSignal) => Promise<StatsAnswer>,
  forgetIdle = false,
): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(() => lastFor.get(key) ?? null);
  const shown = useDocumentShown();
  const asking = useRef(ask);
  asking.current = ask;

  useEffect(() => {
    if (forgetIdle && !active) rememberStats(key, null);
    setStats(lastFor.get(key) ?? null);
    if (!active || !shown) return;
    return pollStats(
      (signal) => asking.current(signal),
      (value) => {
        rememberStats(key, value);
        setStats(value);
      },
    );
  }, [key, active, shown, forgetIdle]);

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
