/**
 * A number that goes up whenever what sessions.snapshot reads may have
 * changed: the stores the sessions are read from, the profiles a chat's
 * row names, which terminals have started, and a terminal's busy spell
 * running out. Main is told the first change after each read
 * (cli.sessionsChanged), so a sessions' list another device watches reads
 * the renderer again only when there is something new to read.
 */

import { ipcCallResult } from "@/ipc/client";
import { BUSY_WINDOW_MS, type TabActivity } from "../../../shared/sessions/agent-state";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { subscribeTabActivity, useTabActivityStore } from "../../state/stores/tab-activity";
import { SESSION_STORES } from "../agent-sessions/use-inbox";
import { onTerminalControllersChanged } from "../terminal/terminal-registry";

/**
 * Counts on from when this renderer started, in milliseconds: one loaded
 * again (a reload, the dev build's hot reload) starts past the last one's,
 * as main keeps the highest it has seen.
 */
let revision = Date.now();
/** Whether main was told of a change since its last read. */
let told = false;
let pendingNotice: object | undefined;

/** The revision now. */
export function sessionsRevision(): number {
  return revision;
}

/** A read of the sessions now: the revision it reads at; the next change is news to main. */
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
  // After the changes made in the same task, which need no telling each.
  queueMicrotask(async () => {
    if (pendingNotice !== notice) return;
    try {
      if ((await ipcCallResult("cli", "sessionsChanged", { revision })).ok) return;
    } catch {
      // The next change can tell main again.
    }
    if (pendingNotice === notice) {
      pendingNotice = undefined;
      told = false;
    }
  });
}

/** Whether two activity reads tell the same of every terminal; a read's own time is no change. */
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

/** Stops the count started last, if it still runs. */
let stopRunning: (() => void) | null = null;

/**
 * Starts counting the changes, in place of a count started before (one
 * count, however often the app boots), and tells main where it starts.
 * Returns the stop.
 */
export function startSessionsRevision(): () => void {
  stopRunning?.();
  let busyTimer: ReturnType<typeof setTimeout> | null = null;
  // A terminal printed lately is busy until BUSY_WINDOW_MS after; no store moves when that ends.
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
