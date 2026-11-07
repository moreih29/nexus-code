/**
 * The sessions the agent manager handed work to, as they stand now, the
 * latest task first: what its dock lists.
 */

import { useEffect, useState } from "react";
import { useManagerStore } from "../../state/stores/manager";
import { useTabActivityStore } from "../../state/stores/tab-activity";
import { type AgentSession, sessionsOf } from "../sessions/model";
import { SESSION_STORES, sessionsInputNow } from "../sessions/use-inbox";

function tasksNow(): AgentSession[] {
  const tasks = Object.values(useManagerStore.getState().tasks).sort((a, b) => b.since - a.since);
  if (tasks.length === 0) return [];
  const input = sessionsInputNow(useTabActivityStore.getState().activity);
  const byKey = new Map<string, AgentSession>();
  for (const workspace of input.workspaces) {
    if (!tasks.some((task) => task.workspaceId === workspace.id)) continue;
    for (const session of sessionsOf(input, workspace)) byKey.set(session.key, session);
  }
  return tasks.flatMap((task) => byKey.get(`${task.workspaceId}:${task.tabId}`) ?? []);
}

function same(a: readonly AgentSession[], b: readonly AgentSession[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => {
      const t = b[i] as AgentSession;
      return s.key === t.key && s.state === t.state && s.title === t.title && s.since === t.since;
    })
  );
}

export function useManagerTasks(): readonly AgentSession[] {
  const [sessions, setSessions] = useState(tasksNow);
  useEffect(() => {
    const update = (): void => {
      const next = tasksNow();
      setSessions((prev) => (same(prev, next) ? prev : next));
    };
    const stops = [...SESSION_STORES, useManagerStore].map((store) => store.subscribe(update));
    update();
    return () => {
      for (const stop of stops) stop();
    };
  }, []);
  return sessions;
}
