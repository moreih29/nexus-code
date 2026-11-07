/**
 * The sessions' state changes, logged for nexus events: as the stores move,
 * every workspace's sessions are read as the agent view reads them, and what
 * changed since the last read is logged (session-changes.ts). The log keeps
 * the last LOG_SIZE changes; seq counts up from 1 while the app runs.
 */

import type { CliSessionEvent } from "../../../shared/cli/ui";
import { useTabActivityStore } from "../../state/stores/tab-activity";
import { markSessions, type SessionMark, sessionChanges } from "./session-changes";
import { SESSION_STORES, sessionsInputNow } from "./use-inbox";

const LOG_SIZE = 1000;
/** Changes that come in a burst (a streaming answer moves the chat store) are read once. */
const SETTLE_MS = 200;

const log: CliSessionEvent[] = [];
let lastSeq = 0;
let marks: Map<string, SessionMark> | null = null;
const listeners = new Set<(events: readonly CliSessionEvent[]) => void>();

/** Reads the sessions now and logs what changed since the last read. */
function record(): void {
  const input = sessionsInputNow(useTabActivityStore.getState().activity);
  const next = markSessions(input.workspaces, input);
  // The first read is where the log starts from, not a change.
  const events = marks === null ? [] : sessionChanges(marks, next, Date.now(), lastSeq + 1);
  marks = next;
  if (events.length === 0) return;
  lastSeq += events.length;
  log.push(...events);
  if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
  for (const listener of listeners) listener(events);
}

/** Starts logging the sessions' changes. Returns the stop. */
export function startSessionEvents(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      record();
    }, SETTLE_MS);
  };
  const stops = SESSION_STORES.map((store) => store.subscribe(schedule));
  record();
  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const stop of stops) stop();
  };
}

/**
 * The changes after `since` (all kept when left out), the last `limit` of
 * them, and the seq of the latest change there is.
 */
export function readSessionEvents(
  since: number | undefined,
  limit: number,
): { events: CliSessionEvent[]; cursor: number } {
  // Pending changes count: a read right after one sees it.
  record();
  // A seq from before the app restarted counts from the start.
  const from = since === undefined || since > lastSeq ? 0 : since;
  const after = log.filter((event) => event.seq > from);
  return { events: after.slice(Math.max(0, after.length - limit)), cursor: lastSeq };
}

/** Calls `listener` with each batch of changes as it is logged. Returns the unsubscribe. */
export function onSessionEvents(
  listener: (events: readonly CliSessionEvent[]) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
