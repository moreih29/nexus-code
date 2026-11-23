import { ipcCallResult } from "@/ipc/client";
import { BUSY_WINDOW_MS, type TabActivity } from "../../../shared/sessions/agent-state";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { subscribeTabActivity, useTabActivityStore } from "../../state/stores/tab-activity";
import { SESSION_STORES } from "../agent-sessions/use-inbox";
import { onTerminalControllersChanged } from "../terminal/terminal-registry";

let revision = Date.now();
let told = false;
let pendingNotice: object | undefined;

export function sessionsRevision(): number {
  return revision;
}

export function readSessionsRevision(): number {
  told = false;
  pendingNotice = undefined;
  return revision;
}

function changed(): void {
  revision++;
  if (told) return;
  told = true;
  const notice = {};
  pendingNotice = notice;
  queueMicrotask(async () => {
    if (pendingNotice !== notice) return;
    try {
      if ((await ipcCallResult("cli", "sessionsChanged", { revision })).ok) return;
    } catch {}
    if (pendingNotice === notice) {
      pendingNotice = undefined;
      told = false;
    }
  });
}

export function sameActivity(
  a: ReadonlyMap<string, TabActivity>,
  b: ReadonlyMap<string, TabActivity>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, x] of a) {
    const y = b.get(key);
    if (
      !y ||
      x.lastOutputAt !== y.lastOutputAt ||
      x.program !== y.program ||
      x.lastNotice?.at !== y.lastNotice?.at ||
      x.lastNotice?.title !== y.lastNotice?.title ||
      x.lastNotice?.body !== y.lastNotice?.body
    )
      return false;
  }
  return true;
}

let stopRunning: (() => void) | null = null;

export function startSessionsRevision(): () => void {
  stopRunning?.();
  let busyTimer: ReturnType<typeof setTimeout> | null = null;
  const whenBusyEnds = (activity: ReadonlyMap<string, TabActivity>): void => {
    if (busyTimer !== null) clearTimeout(busyTimer);
    busyTimer = null;
    let latest = -Infinity;
    for (const { lastOutputAt } of activity.values()) latest = Math.max(latest, lastOutputAt);
    const left = latest + BUSY_WINDOW_MS - Date.now();
    if (left <= 0) return;
    busyTimer = setTimeout(() => {
      busyTimer = null;
      changed();
    }, left + 50);
  };
  const stops = [
    ...SESSION_STORES.filter((store) => store.subscribe !== subscribeTabActivity).map((store) =>
      store.subscribe(changed),
    ),
    useAgentProfilesStore.subscribe(changed),
    useTabActivityStore.subscribe((state, previous) => {
      if (sameActivity(state.activity, previous.activity)) return;
      changed();
      whenBusyEnds(state.activity);
    }),
    onTerminalControllersChanged(changed),
  ];
  whenBusyEnds(useTabActivityStore.getState().activity);
  changed();
  const stop = (): void => {
    if (stopRunning !== stop) return;
    stopRunning = null;
    if (busyTimer !== null) clearTimeout(busyTimer);
    for (const unsubscribe of stops) unsubscribe();
  };
  stopRunning = stop;
  return stop;
}
