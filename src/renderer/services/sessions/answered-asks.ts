/**
 * Permission requests a terminal's Claude Code holds, answered from the
 * app: hidden as soon as the answer reaches Claude Code, not when the next
 * poll (a second or so later) leaves them out. One a poll still lists a
 * while later is shown again, as the answer did not take.
 */

import { useMemo } from "react";
import { create } from "zustand";
import type { PermissionAsk } from "../../../shared/claude/activity";

/** How long an answered request stays hidden while polls still list it. */
export const ANSWERED_HIDE_MS = 4_000;

interface AnsweredAsksState {
  keys: ReadonlySet<string>;
}

export const useAnsweredAsksStore = create<AnsweredAsksState>(() => ({ keys: new Set() }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();

interface SessionRef {
  workspaceId: string;
  tabId: string;
}

function keyOf(session: SessionRef, askId: string): string {
  return `${session.workspaceId}|${session.tabId}|${askId}`;
}

function setKeys(change: (keys: Set<string>) => void): void {
  useAnsweredAsksStore.setState((state) => {
    const keys = new Set(state.keys);
    change(keys);
    return { keys };
  });
}

/** The answer to `askId` reached Claude Code: hidden for a while. */
export function markAnswered(
  session: SessionRef,
  askId: string,
  hideMs: number = ANSWERED_HIDE_MS,
): void {
  const key = keyOf(session, askId);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      setKeys((keys) => keys.delete(key));
    }, hideMs),
  );
  setKeys((keys) => keys.add(key));
}

/** `asks` without those answered from the app a moment ago. */
export function unansweredAsks(
  session: SessionRef,
  asks: readonly PermissionAsk[],
  answered: ReadonlySet<string>,
): readonly PermissionAsk[] {
  if (answered.size === 0) return asks;
  return asks.filter((ask) => !answered.has(keyOf(session, ask.id)));
}

/** `asks` as they show: those answered from the app a moment ago left out. */
export function useUnansweredAsks(
  session: SessionRef,
  asks: readonly PermissionAsk[],
): readonly PermissionAsk[] {
  const answered = useAnsweredAsksStore((s) => s.keys);
  const { workspaceId, tabId } = session;
  return useMemo(
    () => unansweredAsks({ workspaceId, tabId }, asks, answered),
    [workspaceId, tabId, asks, answered],
  );
}

/** For tests: forgets every answer and its timer. */
export function resetAnsweredAsks(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  useAnsweredAsksStore.setState({ keys: new Set() });
}
