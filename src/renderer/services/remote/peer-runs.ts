/**
 * The `claude -p` and `codex exec` runs another computer's chat's session
 * started, as a chat here shows its own beside its subagents (from 0.13.0,
 * chat.runs): read while the chat shows, again every few seconds while one
 * runs and now and then while none does; and one run whole (chat.run) for
 * its pane, read again while it runs; and its own session as a conversation
 * (chat.runRead), where that computer tells it. A device before 0.13.0 has
 * none.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatPage, ChatRun } from "../../../../packages/remote-protocol/src";
import type { AgentRun } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import type { ChatModel } from "../chat/model";
import type { AgentRow } from "../chat/panel";
import { keepEarlier, modelOfPage, withEarlier } from "./chat-model";
import type { PeerChatRef } from "./peer-mcp";

/** How often the runs are read while one runs. */
export const RUNS_LIVE_MS = 2000;
/** How often they are read while none runs, for a run that starts. */
export const RUNS_IDLE_MS = 10_000;
/** How often a run's pane reads it again while it runs. */
export const RUN_LIVE_MS = 1500;
/** How often its pane reads its session again while it runs. */
export const RUN_READ_LIVE_MS = 3000;
/** How often a run that computer said it has no session of is asked for again while it runs. */
export const RUN_READ_SLOW_MS = 15_000;

/** What a run's row is keyed by among the chat's agents, as a chat here keys its runs. */
const RUN_KEY_PREFIX = "print:";

const NO_RUNS: readonly ChatRun[] = [];

function running(run: Pick<ChatRun, "end">): boolean {
  return run.end === undefined;
}

/** A run as the app's own records have it, for the views that show those. */
export function agentRunOf(run: ChatRun): AgentRun {
  return {
    id: run.id,
    kind: "print",
    ...(run.program ? { program: run.program } : {}),
    ...(run.endpoint ? { endpoint: run.endpoint } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.description ? { description: run.description } : {}),
    ...(run.prompt ? { prompt: run.prompt } : {}),
    start: run.start,
    ...(run.end !== undefined ? { end: run.end } : {}),
    state: run.state,
    ...(run.answer ? { answer: run.answer } : {}),
    tools: run.tools ?? [],
    ...(run.messages ? { messages: run.messages } : {}),
    toolCount: run.toolCount,
    failedCount: run.failedCount,
    ...(run.toolsTold ? { toolsTold: true } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The runs as rows of the chat's agents, oldest first, as a chat here lists its own (printRunRows). */
export function peerRunRows(runs: readonly ChatRun[]): AgentRow[] {
  return [...runs]
    .sort((a, b) => a.start - b.start)
    .map((run) => {
      const program = run.program === "codex" ? "codex exec" : "claude -p";
      return {
        toolUseId: `${RUN_KEY_PREFIX}${run.id}`,
        description: oneLine(run.prompt ?? run.description ?? "") || program,
        subagentType: program,
        ...(run.model ? { model: run.model } : {}),
        ...(run.endpoint ? { endpoint: run.endpoint } : {}),
        status: run.state === "permissionPending" ? "running" : run.state,
        startedAt: run.start,
        ...(run.end !== undefined ? { endedAt: run.end } : {}),
        toolCount: run.toolCount,
        ...(run.current ? { currentTool: run.current } : {}),
        ...(run.last ? { lastText: run.last } : {}),
        ...(run.prompt ? { prompt: run.prompt } : {}),
        teammate: false,
        run: agentRunOf(run),
      };
    });
}

/** The chat's runs while `enabled`; none from a device that does not tell them. */
export function usePeerRuns(ref: PeerChatRef, enabled: boolean): readonly ChatRun[] {
  const { deviceId, workspaceId, tabId } = ref;
  const [runs, setRuns] = useState<readonly ChatRun[]>(NO_RUNS);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another chat's runs are not this one's
  useEffect(() => {
    setRuns(NO_RUNS);
  }, [deviceId, workspaceId, tabId]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const result = await ipcCallResult("remote", "peerChatRuns", {
        deviceId,
        workspaceId,
        tabId,
      });
      if (!live) return;
      // A device before 0.13.0 tells none: not asked again.
      if (!result.ok && result.kind === "unsupported") return;
      const now = result.ok ? result.value.runs : null;
      if (now) setRuns((was) => (JSON.stringify(was) === JSON.stringify(now) ? was : now));
      timer = setTimeout(read, now?.some(running) ? RUNS_LIVE_MS : RUNS_IDLE_MS);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deviceId, workspaceId, tabId, enabled]);
  return runs;
}

/**
 * One run whole, for its pane while `enabled`: read again while it runs;
 * until the first read, the row's `row` stands for it.
 */
export function usePeerRun(ref: PeerChatRef, row: AgentRun, enabled: boolean): AgentRun {
  const { deviceId, workspaceId, tabId } = ref;
  const runId = row.id;
  const [read, setRead] = useState<ChatRun | null>(null);
  const ended = row.end !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another run's read is not this one's
  useEffect(() => {
    setRead(null);
  }, [deviceId, workspaceId, tabId, runId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again once its row says it ended, for how it ended
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const result = await ipcCallResult("remote", "peerChatRun", {
        deviceId,
        workspaceId,
        tabId,
        runId,
      });
      if (!live) return;
      if (result.ok) setRead(result.value.run);
      if (result.ok && running(result.value.run)) timer = setTimeout(ask, RUN_LIVE_MS);
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deviceId, workspaceId, tabId, runId, enabled, ended]);
  return useMemo(() => (read ? agentRunOf(read) : row), [read, row]);
}

/**
 * How long until a run's session is asked for again after an ask that ended
 * with `failure` (null: it was read); null when it is not. While it runs:
 * soon after a read and after an ask that did not arrive or found none yet,
 * slowly after "no such run or session" (an older app says so of a session
 * not written yet). Not after one that computer refused (not allowed, no
 * such method), and not once the run ended: it is asked for once more then.
 */
export function runReadAfter(failure: string | null, ended: boolean): number | null {
  if (ended) return null;
  if (failure === null || failure === "unavailable") return RUN_READ_LIVE_MS;
  return failure === "not-found" ? RUN_READ_SLOW_MS : null;
}

/** A run's session as its pane shows it, read from the computer that has it. */
export interface PeerRunConversation {
  model: ChatModel;
  older?: { count: number; loading: boolean; load(): void };
}

/**
 * One run's own session as a conversation (chat.runRead), for its pane
 * while `enabled`: its last page, read again while it runs, with the
 * earlier ones as they are asked for. Null until read, and from a computer
 * that does not tell it or for a run that keeps none: the pane then shows
 * what the run told.
 */
export function usePeerRunConversation(
  ref: PeerChatRef,
  row: AgentRun,
  enabled: boolean,
): PeerRunConversation | null {
  const { deviceId, workspaceId, tabId } = ref;
  const runId = row.id;
  const ended = row.end !== undefined;
  const [page, setPage] = useState<ChatPage | null>(null);
  const [loading, setLoading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another run's read is not this one's
  useEffect(() => {
    setPage(null);
    setLoading(false);
  }, [deviceId, workspaceId, tabId, runId]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const result = await ipcCallResult("remote", "peerChatRunRead", {
        deviceId,
        workspaceId,
        tabId,
        runId,
      });
      if (!live) return;
      if (result.ok) {
        const fresh = result.value;
        setPage((old) => (old ? keepEarlier(old, fresh) : fresh));
      }
      const after = runReadAfter(result.ok ? null : result.kind, ended);
      if (after !== null) timer = setTimeout(ask, after);
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deviceId, workspaceId, tabId, runId, enabled, ended]);
  const start = page?.start ?? 0;
  const load = useCallback(() => {
    if (start <= 0) return;
    setLoading(true);
    void ipcCallResult("remote", "peerChatRunRead", {
      deviceId,
      workspaceId,
      tabId,
      runId,
      before: start,
    }).then((result) => {
      setLoading(false);
      if (result.ok) setPage((now) => (now ? withEarlier(now, result.value) : now));
    });
  }, [deviceId, workspaceId, tabId, runId, start]);
  return useMemo(() => {
    if (!page || page.items.length === 0) return null;
    return {
      model: modelOfPage(page),
      ...(page.start > 0 ? { older: { count: page.start, loading, load } } : {}),
    };
  }, [page, loading, load]);
}
