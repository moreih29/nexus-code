/**
 * The live data of a sessions tab: its workspace's family of sessions, the
 * output activity that tells Codex and other agents' state, each
 * worktree's uncommitted changes, and what the sessions did over time.
 * Polls only while the tab is shown.
 */

import { useEffect, useMemo, useState } from "react";
import type { GitStatus } from "../../../shared/git/types";
import type { TabActivity, TerminalWait } from "../../../shared/sessions/agent-state";
import type { SessionSpan } from "../../../shared/sessions/history";
import { ipcCallResult } from "../../ipc/client";
import { useClaudeStatusStore } from "../../state/stores/claude-status";
import { useTabsStore } from "../../state/stores/tabs";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "../../state/stores/workspaces";
import { activityByKey, buildFamily, type SessionFamily, sameActivity } from "./model";
import { rangeStart, type TimelineRange } from "./timeline";

const ACTIVITY_POLL_MS = 1_000;
const WAITS_POLL_MS = 1_000;
const HISTORY_POLL_MS = 2_000;
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
 * Every live terminal's output activity, keyed by `${workspaceId}:${tabId}`,
 * polled every `everyMs` while `enabled`. A poll that reads what the last
 * one did keeps its map, so nothing built from it is rebuilt.
 */
export function useTabActivity(
  enabled: boolean,
  everyMs = ACTIVITY_POLL_MS,
): ReadonlyMap<string, TabActivity> {
  const [activity, setActivity] = useState<ReadonlyMap<string, TabActivity>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      const result = await ipcCallResult("cli", "activity", {});
      if (cancelled || !result.ok) return;
      const next = activityByKey(result.value);
      setActivity((prev) => (sameActivity(prev, next) ? prev : next));
    };
    void poll();
    const timer = setInterval(() => void poll(), everyMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, everyMs]);
  return activity;
}

/** Which terminals are waiting on which (nexus terminal wait), polled while `enabled`. */
export function useTerminalWaits(enabled: boolean): readonly TerminalWait[] {
  const [waits, setWaits] = useState<readonly TerminalWait[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      const result = await ipcCallResult("cli", "waits", {});
      if (!cancelled && result.ok) setWaits(result.value);
    };
    void poll();
    const timer = setInterval(() => void poll(), WAITS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return waits;
}

/**
 * What the terminals of `workspaceIds` did over `range`, polled while
 * `enabled`.
 */
export function useSessionHistory(
  workspaceIds: readonly string[],
  range: TimelineRange,
  enabled: boolean,
): readonly SessionSpan[] {
  const ids = workspaceIds.join(",");
  const [spans, setSpans] = useState<readonly SessionSpan[]>([]);
  useEffect(() => {
    if (!enabled || ids === "") return;
    let cancelled = false;
    const poll = async () => {
      const result = await ipcCallResult("cli", "history", {
        workspaceIds: ids.split(","),
        since: rangeStart(range, Date.now()),
      });
      if (!cancelled && result.ok) setSpans(result.value);
    };
    void poll();
    const timer = setInterval(() => void poll(), HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ids, range, enabled]);
  return spans;
}

/**
 * The family of the workspace a sessions tab is in, kept current while
 * `visible`, and the time it was read at.
 */
export function useSessionFamily(
  workspaceId: string,
  visible: boolean,
): { family: SessionFamily | null; now: number } {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const tabsByWorkspace = useTabsStore((s) => s.byWorkspace);
  const claudeByWorkspace = useClaudeStatusStore((s) => s.byWorkspace);
  const activity = useTabActivity(visible);
  const now = useNow(visible);
  const family = useMemo(
    () =>
      buildFamily({
        workspaces,
        workspaceId,
        tabsByWorkspace,
        claudeByWorkspace,
        activity,
        now,
      }),
    [workspaces, workspaceId, tabsByWorkspace, claudeByWorkspace, activity, now],
  );
  return { family, now };
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
    let cancelled = false;
    const poll = async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          const result = await ipcCallResult("git", "getStatus", { workspaceId: id });
          return result.ok ? ([id, changesOf(result.value)] as const) : null;
        }),
      );
      if (cancelled) return;
      setChanges(new Map(results.filter((r) => r !== null)));
    };
    void poll();
    const timer = setInterval(() => void poll(), CHANGES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [online, visible]);
  return changes;
}
