import type { RelaySender } from "../../../shared/chat/relay";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { pruneAttachmentsAfterAttach } from "./attach-retention";
import type { ChatLine } from "./model";
import type { ChatTabState } from "./store";
import type { LiveLines } from "./transport/live-lines";
import { cancelQueuedMessage, type QueuedMessage } from "./transport/queue";

const REPLAY_CATCH_UP_MS = 3_000;

export interface ReplayResult {
  found: boolean;
  running: boolean;
  truncated: boolean;
  lastSeq: number;
}

export interface TabTarget {
  workspaceId: string;
  tabId: string;
}

export interface ReplayingTab {
  readonly target: TabTarget;
  readonly live: LiveLines;
  disposed(): boolean;
  lastSeq(): number;
  flushNow(): void;
  keep(lines: ChatLine[]): void;
}

type TabUpdate = (change: (prev: ChatTabState) => ChatTabState) => void;

export async function replayTab(tab: ReplayingTab, afterSeq?: number): Promise<ReplayResult> {
  const { workspaceId, tabId } = tab.target;
  tab.live.hold();
  try {
    const replay = unwrapIpcResult(
      await ipcCallResult("chat", "replay", {
        workspaceId,
        tabId,
        ...(afterSeq !== undefined ? { afterSeq } : {}),
      }),
    );
    await catchUp(tab, replay);
    return replay;
  } finally {
    const held = tab.live.release();
    if (held.length > 0 && !tab.disposed()) {
      tab.keep(held);
      tab.flushNow();
    }
  }
}

async function catchUp(tab: ReplayingTab, replay: ReplayResult): Promise<void> {
  tab.flushNow();
  if (!replay.found) return;
  const deadline = Date.now() + REPLAY_CATCH_UP_MS;
  while (tab.lastSeq() < replay.lastSeq && !tab.disposed() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 16));
    tab.flushNow();
  }
}

export function heldTab(prev: ChatTabState): ChatTabState {
  return prev.phase === "ready" ? { ...prev, phase: "held" } : prev;
}

export function removeQueuedIn(
  state: ChatTabState,
  update: TabUpdate,
  id: string,
): QueuedMessage | undefined {
  const item = state.queue.find((q) => q.id === id && q.status !== "sending");
  if (!item) return undefined;
  update((prev) => cancelQueuedMessage(prev, id));
  return item;
}

export function editQueuedIn(
  state: ChatTabState,
  update: TabUpdate,
  id: string,
  text: string,
  device?: string,
  from?: RelaySender,
): boolean {
  if (!state.queue.some((q) => q.id === id && !q.status)) return false;
  update((prev) => ({
    ...prev,
    queue: prev.queue.map((q) => {
      if (q.id !== id) return q;
      if (from) return { ...q, text, from, device };
      if (!device) return { ...q, text };
      const { from: _agent, ...rest } = q;
      return { ...rest, text, device };
    }),
  }));
  return true;
}

export async function attachToTab(target: TabTarget, name: string, data: string): Promise<string> {
  const { workspaceId, tabId } = target;
  const result = unwrapIpcResult(
    await ipcCallResult("chat", "attach", { workspaceId, tabId, name, data }),
  );
  pruneAttachmentsAfterAttach(workspaceId);
  return result.path;
}
