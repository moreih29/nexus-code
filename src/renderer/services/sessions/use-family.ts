/**
 * The live data of a sessions tab: its workspace's family of sessions, the
 * output activity that tells Codex and other agents' state, what Claude
 * sessions are doing (their tools and agents), each worktree's uncommitted
 * changes, and which terminals wait on which. Polls only while the tab is
 * shown.
 */

import { useEffect, useRef, useState } from "react";
import type { GitStatus } from "../../../shared/git/types";
import { createLogger } from "../../../shared/log/renderer";
import type { TabActivity, TerminalWait } from "../../../shared/sessions/agent-state";
import { ipcCallResult } from "../../ipc/client";
import { useClaudeStatusStore } from "../../state/stores/claude-status";
import { useSessionSeenStore } from "../../state/stores/session-seen";
import { useTabsStore } from "../../state/stores/tabs";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "../../state/stores/workspaces";
import { useChatStore } from "../chat/store";
import {
  activityByKey,
  buildFamily,
  type SessionFamily,
  sameActivity,
  sameFamily,
} from "./model";
import { type ActivityByKey, activityMap, sameActivityMap } from "./agents";
import { viewingKey } from "./viewing";

const log = createLogger("sessions");

const ACTIVITY_POLL_MS = 1_000;
const CLAUDE_ACTIVITY_POLL_MS = 1_000;
const WAITS_POLL_MS = 1_000;
const CHANGES_POLL_MS = 5_000;

/** The current time, ticking every `everyMs` while `enabled`. */
export function useNow(enabled: boolean, everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [enabled, everyMs]);
  return now;
}

/**
 * Runs `read` now and every `everyMs` until stopped, one read at a time: a
 * tick while a read is still out is skipped, so a slow answer never lands
 * after a newer one. `read` is told whether its answer is still the latest
 * wanted, which it is not once polling stops.
 */
export function startPolling(
  read: (isLatest: () => boolean) => Promise<void>,
  everyMs: number,
): () => void {
  let stopped = false;
  let reading = false;
  let sequence = 0;
  const tick = async (): Promise<void> => {
    if (stopped || reading) return;
    reading = true;
    const mine = ++sequence;
    try {
      await read(() => !stopped && mine === sequence);
    } catch (failure) {
      log.warn(`poll failed: ${(failure as Error).message}`);
    } finally {
      reading = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Whether two reads list the same, to keep the one already shown. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which terminals are waiting on which (nexus terminal wait), polled while `enabled`. */
export function useTerminalWaits(enabled: boolean): readonly TerminalWait[] {
  const [waits, setWaits] = useState<readonly TerminalWait[]>([]);
  useEffect(() => {
    if (!enabled) return;
    return startPolling(async (isLatest) => {
      const result = await ipcCallResult("cli", "waits", {});
      if (isLatest() && result.ok) {
        setWaits((prev) => (sameJson(prev, result.value) ? prev : result.value));
      }
    }, WAITS_POLL_MS);
  }, [enabled]);
  return waits;
}

/**
 * What the Claude sessions of `workspaceIds` are doing — their tools, todos
 * and agents — by session key, polled while `enabled`.
 */
export function useSessionActivity(
  workspaceIds: readonly string[],
  enabled: boolean,
): ActivityByKey {
  const ids = workspaceIds.join(",");
  const [activity, setActivity] = useState<ActivityByKey>(() => new Map());
  useEffect(() => {
    if (!enabled || ids === "") return;
    return startPolling(async (isLatest) => {
      const result = await ipcCallResult("claude", "activity", { workspaceIds: ids.split(",") });
      if (isLatest() && result.ok) {
        const next = activityMap(result.value);
        setActivity((prev) => (sameActivityMap(prev, next) ? prev : next));
      }
    }, CLAUDE_ACTIVITY_POLL_MS);
  }, [ids, enabled]);
  return activity;
}

/** The family of `workspaceId` as the stores and `activity` tell it now. */
function familyNow(
  workspaceId: string,
  activity: ReadonlyMap<string, TabActivity>,
): SessionFamily | null {
  return buildFamily({
    workspaces: useWorkspacesStore.getState().workspaces,
    workspaceId,
    tabsByWorkspace: useTabsStore.getState().byWorkspace,
    claudeByWorkspace: useClaudeStatusStore.getState().byWorkspace,
    activity,
    now: Date.now(),
    seenByWorkspace: useSessionSeenStore.getState().byWorkspace,
    chats: useChatStore.getState().tabs,
    viewing: viewingKey(),
  });
}

/**
 * The family of the workspace a sessions tab is in, kept current while
 * `visible`: rebuilt as the stores change and as the output activity is read,
 * which is also when a busy agent can turn quiet. A rebuild that tells the
 * same keeps the family already shown, so the views render only on a change.
 */
export function useSessionFamily(workspaceId: string, visible: boolean): SessionFamily | null {
  // Kept while the tab is hidden, so showing it again starts from the last read.
  const activity = useRef<ReadonlyMap<string, TabActivity>>(new Map());
  const [family, setFamily] = useState(() => familyNow(workspaceId, activity.current));
  useEffect(() => {
    if (!visible) return;
    const update = (): void => {
      const next = familyNow(workspaceId, activity.current);
      setFamily((prev) => (sameFamily(prev, next) ? prev : next));
    };
    const stops = [
      useWorkspacesStore.subscribe(update),
      useTabsStore.subscribe(update),
      useClaudeStatusStore.subscribe(update),
      useSessionSeenStore.subscribe(update),
      useChatStore.subscribe(update),
      startPolling(async (isLatest) => {
        const result = await ipcCallResult("cli", "activity", {});
        if (!isLatest()) return;
        if (result.ok) {
          const next = activityByKey(result.value);
          if (!sameActivity(activity.current, next)) activity.current = next;
        }
        update();
      }, ACTIVITY_POLL_MS),
    ];
    update();
    return () => {
      for (const stop of stops) stop();
    };
  }, [workspaceId, visible]);
  return family;
}

/** A file a worktree has changed and not committed. */
export interface ChangedFile {
  readonly relPath: string;
  /** M, A, D, R, C, U (conflict) or ? (untracked). */
  readonly code: string;
}

export interface WorktreeChanges {
  /** The checked-out branch, as git reports it. */
  readonly branch: string | undefined;
  readonly files: readonly ChangedFile[];
}

function changesOf(status: GitStatus): WorktreeChanges {
  const files = new Map<string, ChangedFile>();
  for (const entry of [...status.merge, ...status.staged, ...status.working]) {
    if (files.has(entry.relPath)) continue;
    const code = entry.conflictType ? "U" : (entry.xy.replace(/[ .]/g, "")[0] ?? "M");
    files.set(entry.relPath, { relPath: entry.relPath, code });
  }
  for (const entry of status.untracked) {
    if (!files.has(entry.relPath)) files.set(entry.relPath, { relPath: entry.relPath, code: "?" });
  }
  return { branch: status.branch?.current || undefined, files: [...files.values()] };
}

/**
 * The changes of the worktrees just read; one whose read failed keeps what it
 * last showed rather than dropping its count.
 */
export function mergeChanges(
  prev: ReadonlyMap<string, WorktreeChanges>,
  reads: readonly (readonly [string, WorktreeChanges | undefined])[],
): ReadonlyMap<string, WorktreeChanges> {
  const next = new Map<string, WorktreeChanges>();
  for (const [id, read] of reads) {
    const kept = read ?? prev.get(id);
    if (kept) next.set(id, kept);
  }
  return next;
}

/**
 * Each connected worktree's uncommitted changes, polled while `visible`.
 * A worktree not connected yet has none listed rather than being connected
 * by the poll.
 */
export function useWorktreeChanges(
  workspaceIds: readonly string[],
  visible: boolean,
): ReadonlyMap<string, WorktreeChanges> {
  const online = useWorkspacesStore((s) =>
    workspaceIds.filter((id) => selectIsWorkspaceOnline(s, id)).join(","),
  );
  const [changes, setChanges] = useState<ReadonlyMap<string, WorktreeChanges>>(() => new Map());
  useEffect(() => {
    if (!visible || online === "") return;
    const ids = online.split(",");
    return startPolling(async (isLatest) => {
      const results = await Promise.all(
        ids.map(async (id) => {
          const result = await ipcCallResult("git", "getStatus", { workspaceId: id }).catch(
            () => null,
          );
          return [id, result?.ok ? changesOf(result.value) : undefined] as const;
        }),
      );
      if (isLatest()) setChanges((prev) => mergeChanges(prev, results));
    }, CHANGES_POLL_MS);
  }, [online, visible]);
  return changes;
}
