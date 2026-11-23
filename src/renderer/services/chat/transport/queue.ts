import type { RelaySender } from "../../../../shared/chat/relay";
import type { ImageBlock } from "../model";
import type { ChatTabState } from "../store";

export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageBlock[];
  afterTool?: number;
  clientUserMessageId?: string;
  status?: "sending" | "failed" | "unconfirmed";
  error?: string;
  from?: RelaySender;
  device?: string;
}

const MAX_CANCELLED_SUBMISSIONS = 4096;

export function cancelQueuedMessage(state: ChatTabState, id: string): ChatTabState {
  return {
    ...state,
    queue: state.queue.filter((item) => item.id !== id),
    cancelledSubmissions: [
      ...(state.cancelledSubmissions ?? []).slice(1 - MAX_CANCELLED_SUBMISSIONS),
      id,
    ],
  };
}

export function chatSendErrorKind(error: unknown): string | undefined {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : undefined;
}

export function isChatWriteRejected(error: unknown): boolean {
  const kind = chatSendErrorKind(error);
  return kind === "chat.stdin-write-failed" || kind === "chat.not-running";
}

export function dispatchQueuedMessage(
  queue: readonly QueuedMessage[],
  update: (change: (prev: ChatTabState) => ChatTabState) => void,
  send: (item: QueuedMessage) => Promise<QueuedMessage | undefined>,
  rejected: (error: unknown) => boolean,
  observed: (id: string) => boolean,
  settled: () => void,
  eligible: (item: QueuedMessage) => boolean = () => true,
): void {
  if (queue.some((item) => item.status === "sending")) return;
  const next = queue.find((item) => !item.status && eligible(item));
  if (!next) return;
  const sending: QueuedMessage = { ...next, status: "sending" };
  const replace = (item?: QueuedMessage) => {
    let changed = false;
    update((prev) => {
      if (!prev.queue.includes(next) && !prev.queue.includes(sending)) return prev;
      changed = true;
      return {
        ...prev,
        queue: prev.queue.flatMap((entry) =>
          entry === next || entry === sending ? (item ? [item] : []) : [entry],
        ),
      };
    });
    return changed;
  };
  replace(sending);
  void send(next).then(
    (stillHeld) => {
      if (replace(stillHeld)) settled();
    },
    (error: unknown) => {
      if (observed(next.id)) {
        if (replace()) settled();
        return;
      }
      const failed = rejected(error);
      const changed = replace({
        ...next,
        status: failed ? "failed" : "unconfirmed",
        error: String(error instanceof Error ? error.message : error).slice(0, 1000),
      });
      if (changed && failed) settled();
    },
  );
}

export function clearObservedQueued(
  state: ChatTabState,
  observed: (id: string) => boolean,
): ChatTabState {
  const queue = state.queue.filter((item) => item.status !== "unconfirmed" || !observed(item.id));
  return queue.length === state.queue.length ? state : { ...state, queue };
}
