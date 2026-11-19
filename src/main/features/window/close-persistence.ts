import { PendingRequestMap } from "../../../shared/ipc/pending-request-map";
import type { TimerScheduler } from "../../../shared/util/timer-scheduler";
import { MAIN_QUIT_GRACE_MS } from "../../infra/main-shutdown";

/** How long close waits for a renderer to finish its durable layout write. */
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

/** Coordinates a bounded layout flush before Electron runs its unload guards. */
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

  /** Only the window that received this attempt can complete it. */
  acknowledge(senderId: number, attempt: number, saved: boolean): void {
    this.answers.resolve(`${senderId}:${attempt}`, saved);
  }

  /** Pause an individual close, then replay it through the native unload guard. */
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

  /**
   * A prevented BrowserWindow close also cancels app.quit(). Flush all app
   * windows first, then let one normal Electron quit run its close events.
   */
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

  /** The native updater owns its window close sequence. */
  allowUpdaterClose(): void {
    this.quitPhase = "closing";
  }

  /** A cancelled unload leaves subsequent close attempts eligible to flush again. */
  cancelQuit(): void {
    if (this.quitPhase === "closing") {
      this.quitPhase = "idle";
      this.startedQuitAt = undefined;
    }
  }

  /** Counts the time spent preparing renderer closes toward the same quit deadline. */
  remainingQuitMs(): number {
    const elapsed = this.startedQuitAt === undefined ? 0 : this.now() - this.startedQuitAt;
    return Math.max(0, MAIN_QUIT_GRACE_MS - elapsed);
  }

  /** Request at most one flush per window while a close or quit is pending. */
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
          if (!saved) this.warn(`Layout save failed before closing window ${senderId}`);
        },
        (error: unknown) => {
          this.warn(`Layout flush did not complete for window ${senderId}: ${String(error)}`);
        },
      )
      .finally(() => this.windowFlushes.delete(senderId));
    this.windowFlushes.set(senderId, flush);
    return flush;
  }
}
