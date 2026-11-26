import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatPage, ChatRun } from "../../../../packages/remote-protocol/src";
import type { AgentRun } from "../../../shared/claude/activity";
import { ipcCallResult } from "../../ipc/client";
import { conversationLook, imageLook, shownIndex } from "../chat/image-look";
import type { ChatModel, ImageBlock } from "../chat/model";
import { type AgentRow, imagesOf } from "../chat/panel";
import { keepEarlier, modelOfPage, withEarlier } from "./chat-model";
import type { PeerChatRef } from "./peer-mcp";

export const RUNS_LIVE_MS = 2000;
export const RUNS_IDLE_MS = 10_000;
export const RUN_LIVE_MS = 1500;
export const RUN_READ_LIVE_MS = 3000;
export const RUN_READ_SLOW_MS = 15_000;

export async function readPeerRunTool(
  target: PeerChatRef & { runId: string },
  toolUseId: string,
  signal: AbortSignal,
) {
  const reply = await ipcCallResult("remote", "peerChatTool", { ...target, toolUseId }, { signal });
  if (!reply.ok) throw new Error(reply.message);
  const result = reply.value.result;
  if (!result) throw new Error("no tool output in that run");
  return result;
}

export function runImageLook(
  model: ChatModel | undefined,
  cwd: string,
  images: readonly ImageBlock[],
  index: number,
) {
  const image = images[index];
  if (model && image) {
    const gallery = imagesOf(model.items, model.tools, cwd, model.agentItems).filter(
      (entry) => entry.image !== undefined,
    );
    const at = shownIndex(gallery, { image });
    if (at >= 0) return conversationLook(gallery, at, () => false);
  }
  return imageLook(images, index);
}

const RUN_KEY_PREFIX = "print:";

const NO_RUNS: readonly ChatRun[] = [];

function running(run: Pick<ChatRun, "end">): boolean {
  return run.end === undefined;
}

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

export function runReadAfter(failure: string | null, ended: boolean): number | null {
  if (ended) return null;
  if (failure === null || failure === "unavailable") return RUN_READ_LIVE_MS;
  return failure === "not-found" ? RUN_READ_SLOW_MS : null;
}

export interface PeerRunConversation {
  model: ChatModel;
  older?: { count: number; loading: boolean; load(): void };
}

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
