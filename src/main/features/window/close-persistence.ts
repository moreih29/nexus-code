import { PendingRequestMap } from "../../../shared/ipc/pending-request-map";
import type { TimerScheduler } from "../../../shared/util/timer-scheduler";
import { MAIN_QUIT_GRACE_MS } from "../../infra/main-shutdown";

const CLOSE_FLUSH_TIMEOUT_MS = 1_000;

interface CloseWindow {
  readonly webContents: {
    readonly id: number;
    send(channel: string, ...args: unknown[]): void;
  };
  isDestroyed(): boolean;
  close(): void;
}

interface CloseEvent {
  preventDefault(): void;
}

export class ClosePersistence {
  private readonly answers: PendingRequestMap<string, boolean>;
  private readonly windowFlushes = new Map<number, Promise<void>>();
  private readonly requestedCloses = new Set<CloseWindow>();
  private replayingClose: CloseWindow | null = null;
  private quitPhase: "idle" | "flushing" | "closing" = "idle";
  private startedQuitAt?: number;
  private nextAttempt = 1;

  constructor(
    private readonly warn: (message: string) => void,
    scheduler?: TimerScheduler,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.answers = new PendingRequestMap(scheduler);
  }

  acknowledge(senderId: number, attempt: number, saved: boolean): void {
    this.answers.resolve(`${senderId}:${attempt}`, saved);
  }

  interceptClose(event: CloseEvent, win: CloseWindow): void {
    if (this.replayingClose === win || this.quitPhase === "closing") return;
    event.preventDefault();
    if (this.quitPhase === "flushing" || this.requestedCloses.has(win)) return;

    this.requestedCloses.add(win);
    void this.flushWindow(win).then(() => {
      this.requestedCloses.delete(win);
      if (win.isDestroyed() || this.quitPhase !== "idle") return;
      this.replayingClose = win;
      try {
        win.close();
      } finally {
        this.replayingClose = null;
      }
    });
  }

  interceptQuit(event: CloseEvent, windows: CloseWindow[], quit: () => void): void {
    this.startedQuitAt ??= this.now();
    if (this.quitPhase === "closing" || windows.length === 0) return;
    event.preventDefault();
    if (this.quitPhase === "flushing") return;

    this.quitPhase = "flushing";
    void Promise.all(windows.map((win) => this.flushWindow(win))).then(() => {
      this.quitPhase = "closing";
      quit();
    });
  }

  async prepareUpdaterClose(windows: CloseWindow[]): Promise<void> {
    await Promise.all(windows.map((win) => this.flushWindow(win)));
  }

  allowUpdaterClose(): void {
    this.quitPhase = "closing";
  }

  cancelQuit(): void {
    if (this.quitPhase === "closing") {
      this.quitPhase = "idle";
      this.startedQuitAt = undefined;
    }
  }

  remainingQuitMs(): number {
    const elapsed = this.startedQuitAt === undefined ? 0 : this.now() - this.startedQuitAt;
    return Math.max(0, MAIN_QUIT_GRACE_MS - elapsed);
  }

  private flushWindow(win: CloseWindow): Promise<void> {
    const senderId = win.webContents.id;
    const current = this.windowFlushes.get(senderId);
    if (current) return current;

    const attempt = this.nextAttempt++;
    const key = `${senderId}:${attempt}`;
    const answer = this.answers.register({ key, timeoutMs: CLOSE_FLUSH_TIMEOUT_MS });
    try {
      win.webContents.send("ipc:event", "window", "prepareClose", { attempt });
    } catch (error) {
      this.answers.reject(key, new Error(String(error)));
    }

    const flush = answer
      .then(
        (saved) => {
          if (!saved) this.warn(`Save failed before closing window ${senderId}`);
        },
        (error: unknown) => {
          this.warn(`Save did not complete for window ${senderId}: ${String(error)}`);
        },
      )
      .finally(() => this.windowFlushes.delete(senderId));
    this.windowFlushes.set(senderId, flush);
    return flush;
  }
}
