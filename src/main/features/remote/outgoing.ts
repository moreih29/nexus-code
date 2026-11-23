import type {
  REQUEST_CANCEL,
  RpcMethod,
  RpcNotificationMethod,
} from "../../../../packages/remote-protocol/src";
import { createLogger } from "../../../shared/log/main";
import { frameStallDeadline } from "./frame-stall";

const log = createLogger("remote-outgoing");
const RATE_LIMIT_COOLDOWN_MS = 1_000;
const QUEUE_LIMIT = 150;
const BUFFER_CHECK_MS = 25;
const FLOOD_WINDOW_MS = 3_000;
const FLOOD_PAUSE_MS = 5_000;
const FLOOD_FRAME_COUNT = 1_800;
const FILE_CHUNK_FLOOD_COUNT = 3_000;
const FLOOD_WARNING_INTERVAL_MS = 30_000;

export enum FramePriority {
  Hello,
  Reply,
  Request,
  Watch,
  Data,
}

export type FrameKind =
  | "hello"
  | "pairing"
  | `request:${RpcMethod}`
  | `reply:${RpcMethod | "unknown"}`
  | `notification:${RpcNotificationMethod | typeof REQUEST_CANCEL}`;

const FILE_CHUNK_KINDS = new Set<FrameKind>([
  "request:files.read",
  "reply:files.read",
  "request:files.write.chunk",
  "reply:files.write.chunk",
]);

interface OutgoingFrame {
  kind: FrameKind;
  priority: FramePriority;
  snapshotKey?: string;
  wanted?(): boolean;
  send(current: () => boolean): Promise<number | null>;
}

interface QueuedFrame extends OutgoingFrame {
  resolve(seq: number | null): void;
  reject(error: unknown): void;
}

interface FrameActivity {
  since: number;
  count: number;
  resumeAt: number;
  warnedAt: number;
}

export class OutgoingFrames {
  private readonly queue: QueuedFrame[] = [];
  private readonly activity = new Map<FrameKind, FrameActivity>();
  private resumeAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining = false;
  private closed = false;

  constructor(
    private readonly onDrop: () => void,
    private readonly onStall: (elapsedMs: number) => void,
    private readonly dataWritable = () => true,
  ) {}

  get size(): number {
    return this.queue.length;
  }

  push(frame: OutgoingFrame): Promise<number | null> {
    if (this.closed) return Promise.resolve(null);
    if (frame.snapshotKey) {
      const superseded = this.queue.findIndex((item) => item.snapshotKey === frame.snapshotKey);
      if (superseded >= 0) this.drop(superseded);
    }
    if (this.queue.length >= QUEUE_LIMIT) {
      const now = performance.now();
      const priorityOf = (item: OutgoingFrame) =>
        item.priority + (this.resumeTime(item.kind) > now ? FramePriority.Data + 1 : 0);
      const incomingPriority = priorityOf(frame);
      let lowest = -1;
      let lowestPriority = incomingPriority;
      for (const [index, item] of this.queue.entries()) {
        const priority = priorityOf(item);
        if (priority > incomingPriority && priority >= lowestPriority) {
          lowest = index;
          lowestPriority = priority;
        }
      }
      if (lowest < 0) {
        this.onDrop();
        return Promise.resolve(null);
      }
      this.drop(lowest);
    }
    const sent = new Promise<number | null>((resolve, reject) => {
      this.queue.push({ ...frame, resolve, reject });
    });
    this.kick();
    return sent;
  }

  rateLimited(): void {
    this.resumeAt = performance.now() + RATE_LIMIT_COOLDOWN_MS;
    this.kick();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    for (const item of this.queue.splice(0)) item.resolve(null);
  }

  private drop(index: number): void {
    this.queue.splice(index, 1)[0]?.resolve(null);
    this.onDrop();
  }

  private kick(): void {
    if (this.closed || this.draining || this.queue.length === 0) return;
    clearTimeout(this.timer);
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  private resumeTime(kind: FrameKind): number {
    return this.activity.get(kind)?.resumeAt ?? -Infinity;
  }

  private wait(ms: number): void {
    this.timer = setTimeout(() => this.kick(), Math.ceil(ms));
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed && this.queue.length > 0) {
        const now = performance.now();
        if (now < this.resumeAt) return this.wait(this.resumeAt - now);

        let frame: QueuedFrame | undefined;
        let index = -1;
        let nextReadyAt = Infinity;
        for (const [i, item] of this.queue.entries()) {
          const readyAt = this.resumeTime(item.kind);
          if (readyAt > now) {
            nextReadyAt = Math.min(nextReadyAt, readyAt);
          } else if (!frame || item.priority < frame.priority) {
            index = i;
            frame = item;
          }
        }
        if (!frame) return this.wait(nextReadyAt - now);
        if (frame.wanted?.() === false) {
          this.queue.splice(index, 1);
          frame.resolve(null);
          continue;
        }
        if (frame.priority === FramePriority.Data && !this.dataWritable()) {
          return this.wait(BUFFER_CHECK_MS);
        }
        this.queue.splice(index, 1);
        await this.send(frame);
      }
    } finally {
      this.draining = false;
    }
  }

  private countSend(kind: FrameKind): void {
    const now = performance.now();
    let activity = this.activity.get(kind);
    if (!activity) {
      activity = { since: now, count: 0, resumeAt: -Infinity, warnedAt: -Infinity };
      this.activity.set(kind, activity);
    }
    if (now - activity.since >= FLOOD_WINDOW_MS) {
      activity.since = now;
      activity.count = 0;
    }
    const fileChunk = FILE_CHUNK_KINDS.has(kind);
    const limit = fileChunk ? FILE_CHUNK_FLOOD_COUNT : FLOOD_FRAME_COUNT;
    activity.count++;
    if (activity.count !== limit) return;

    const delay =
      !fileChunk && kind !== "hello" && kind !== "pairing" && !kind.startsWith("reply:");
    if (delay) activity.resumeAt = now + FLOOD_PAUSE_MS;
    if (now - activity.warnedAt < FLOOD_WARNING_INTERVAL_MS) return;
    activity.warnedAt = now;
    log.warn(
      `Relay frame burst kind=${kind} count=${activity.count} elapsedMs=${Math.round(now - activity.since)} action=${delay ? "delay" : "observe"}`,
    );
  }

  private async send(frame: QueuedFrame): Promise<void> {
    let expired = false;
    const { expiry, cancel } = frameStallDeadline((elapsed) => {
      expired = true;
      if (!this.closed) this.onStall(elapsed);
    });
    try {
      const current = () => !this.closed && !expired && frame.wanted?.() !== false;
      const seq = await Promise.race([expiry, frame.send(current)]);
      if (seq !== null && !this.closed) this.countSend(frame.kind);
      frame.resolve(seq);
    } catch (error) {
      frame.reject(error);
    } finally {
      cancel();
    }
  }
}
