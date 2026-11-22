import type { RelaySender } from "../../../../shared/chat/relay";
import type { ImageBlock } from "../model";
import type { ChatTabState } from "../store";

export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageBlock[];
  /** Codex may steer after a tool completion later than this log sequence. */
  afterTool?: number;
  /** The Codex submission ID if a refused steer moved this message to the queue. */
  clientUserMessageId?: string;
  status?: "sending" | "failed" | "unconfirmed";
  error?: string;
  /** The agent that sent it through the nexus command, when one did. */
  from?: RelaySender;
  /**
   * The user's other computer it was held from, when it was: it is dropped
   * if control from other computers is turned off before it goes.
   */
  device?: string;
}

const MAX_CANCELLED_SUBMISSIONS = 4096;

/** Removes a held message and lets its waiter distinguish cancellation from delivery. */
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

/** Reads the failure code the chat IPC carried across the process boundary. */
export function chatSendErrorKind(error: unknown): string | undefined {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : undefined;
}

/** The agent knows no bytes of the requested message reached the program. */
export function isChatWriteRejected(error: unknown): boolean {
  const kind = chatSendErrorKind(error);
  return kind === "chat.stdin-write-failed" || kind === "chat.not-running";
}

/** Keeps the payload available for recovery until delivery has been confirmed. */
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
