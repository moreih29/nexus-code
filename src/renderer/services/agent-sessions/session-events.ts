import type { CliSessionEvent } from "../../../shared/cli/ui";
import { useTabActivityStore } from "../../state/stores/tab-activity";
import { markSessions, type SessionMark, sessionChanges } from "./session-changes";
import { SESSION_STORES, sessionsInputNow } from "./use-inbox";

const LOG_SIZE = 1000;
const SETTLE_MS = 200;

const log: CliSessionEvent[] = [];
let lastSeq = 0;
let marks: Map<string, SessionMark> | null = null;
const listeners = new Set<(events: readonly CliSessionEvent[]) => void>();

export function recordSessionEvents(): void {
  const input = sessionsInputNow(useTabActivityStore.getState().activity);
  const next = markSessions(input.workspaces, input);
  const events = marks === null ? [] : sessionChanges(marks, next, Date.now(), lastSeq + 1);
  marks = next;
  if (events.length === 0) return;
  lastSeq += events.length;
  log.push(...events);
  if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
  for (const listener of listeners) listener(events);
}

export function startSessionEvents(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      recordSessionEvents();
    }, SETTLE_MS);
  };
  const stops = SESSION_STORES.map((store) => store.subscribe(schedule));
  recordSessionEvents();
  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const stop of stops) stop();
  };
}

export function readSessionEvents(
  since: number | undefined,
  limit: number,
): { events: CliSessionEvent[]; cursor: number; more: boolean } {
  recordSessionEvents();
  if (since === undefined) {
    return { events: log.slice(Math.max(0, log.length - limit)), cursor: lastSeq, more: false };
  }
  const from = since > lastSeq ? 0 : since;
  const after = log.filter((event) => event.seq > from);
  return { events: after.slice(0, limit), cursor: lastSeq, more: after.length > limit };
}

export function onSessionEvents(
  listener: (events: readonly CliSessionEvent[]) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
