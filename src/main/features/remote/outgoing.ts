/** Paces all sealed frames on one relay socket, before they get sequence numbers. */
export const SEND_FRAMES_PER_SECOND = 160;
export const SEND_FRAME_BURST = 800;
export const RATE_LIMIT_COOLDOWN_MS = 1_000;
const FRAME_STALL_MS = 5_000;
const QUEUE_LIMIT = 150;
const RESERVED_TOKENS = 8;
const BUFFER_CHECK_MS = 25;

export enum FramePriority {
  Hello,
  Reply,
  Request,
  Watch,
  Data,
}

interface OutgoingFrame {
  priority: FramePriority;
  watch?: string;
  wanted?(): boolean;
  send(current: () => boolean): Promise<number | null>;
}

interface QueuedFrame extends OutgoingFrame {
  resolve(seq: number | null): void;
  reject(error: unknown): void;
}

export class OutgoingFrames {
  private readonly queue: QueuedFrame[] = [];
  private tokens = SEND_FRAME_BURST;
  private refilledAt = performance.now();
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
    // A full snapshot replaces the old one. Delta watchers use a revision gap to resync.
    if (frame.watch) {
      const superseded = this.queue.findIndex((item) => item.watch === frame.watch);
      if (superseded >= 0) this.drop(superseded);
    }
    if (this.queue.length >= QUEUE_LIMIT) {
      let lowest = -1;
      let lowestPriority = frame.priority;
      for (const [index, item] of this.queue.entries()) {
        if (item.priority > frame.priority && item.priority >= lowestPriority) {
          lowest = index;
          lowestPriority = item.priority;
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
    // Restart with no burst while the relay replenishes its own budget.
    this.resumeAt = performance.now() + RATE_LIMIT_COOLDOWN_MS;
    this.refilledAt = this.resumeAt;
    this.tokens = 0;
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

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        let frame = this.queue[0];
        if (!frame) return;
        let index = 0;
        for (const [i, item] of this.queue.entries()) {
          if (item.priority < frame.priority) {
            index = i;
            frame = item;
          }
        }
        if (frame.wanted?.() === false) {
          this.queue.splice(index, 1);
          frame.resolve(null);
          continue;
        }
        const now = performance.now();
        const refill = this.resumeAt >= now ? 0 : Math.max(0, now - this.refilledAt);
        this.tokens = Math.min(
          SEND_FRAME_BURST,
          this.tokens + (refill * SEND_FRAMES_PER_SECOND) / 1000,
        );
        this.refilledAt = Math.max(this.resumeAt, now);
        const needed = frame.priority >= FramePriority.Watch ? RESERVED_TOKENS + 1 : 1;
        if (this.tokens < needed) {
          const delay =
            Math.max(0, this.resumeAt - now) +
            ((needed - this.tokens) * 1000) / SEND_FRAMES_PER_SECOND;
          this.timer = setTimeout(() => this.kick(), Math.ceil(delay));
          return;
        }
        if (frame.priority === FramePriority.Data && !this.dataWritable()) {
          this.timer = setTimeout(() => this.kick(), BUFFER_CHECK_MS);
          return;
        }
        this.queue.splice(index, 1);
        this.tokens--;
        await this.send(frame);
      }
    } finally {
      this.draining = false;
    }
  }

  private async send(frame: QueuedFrame): Promise<void> {
    const started = performance.now();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        if (!this.closed) this.onStall(performance.now() - started);
        resolve(null);
      }, FRAME_STALL_MS);
    });
    try {
      const current = () => !this.closed && !expired && frame.wanted?.() !== false;
      frame.resolve(await Promise.race([expiry, frame.send(current)]));
    } catch (error) {
      frame.reject(error);
    } finally {
      clearTimeout(timer);
    }
  }
}
