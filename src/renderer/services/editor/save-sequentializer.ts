// Per-key in-flight task gate. Mirrors VSCode's TaskSequentializer but
// pared to the surface this codebase uses: at most one running task per
// key, plus an at-most-one queued task. A new request while another is
// running cancels the running task (cooperatively, via the abort signal
// passed to the task) and replaces the queued task — guaranteeing two
// writes for the same file never reach disk concurrently and the most
// recent intent wins.
//
// "Cooperative" cancel: the running task receives an AbortSignal. Whether
// it actually short-circuits is up to the task. The sequentializer itself
// only awaits the running promise to settle — it never aborts the I/O
// underneath.
//
// Surface:
//   run(key, fn)    — schedule fn. Returns the promise that resolves when
//                     this fn (or a later replacement) settles.
//   isRunning(key)  — is there an in-flight task for this key?

interface RunningTask<T> {
  promise: Promise<T>;
  controller: AbortController;
}

interface QueuedTask<T> {
  fn: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class SaveSequentializer {
  private running = new Map<string, RunningTask<unknown>>();
  private queued = new Map<string, QueuedTask<unknown>>();

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  run<T>(key: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (!existing) {
      return this.startRunning(key, fn);
    }

    // A new caller replaces any previously queued task for this key —
    // older queued caller's promise rejects so it learns its work was
    // superseded.
    const previousQueued = this.queued.get(key);
    if (previousQueued) {
      previousQueued.reject(new SaveSupersededError(key));
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.queued.set(key, {
        fn: fn as (signal: AbortSignal) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });

    // Signal the running task that a successor has arrived.
    existing.controller.abort();

    return promise;
  }

  private startRunning<T>(key: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const promise = fn(controller.signal).finally(() => {
      this.onSettled(key);
    });
    this.running.set(key, { promise, controller });
    return promise;
  }

  private onSettled(key: string): void {
    this.running.delete(key);

    const next = this.queued.get(key);
    if (!next) return;
    this.queued.delete(key);

    const controller = new AbortController();
    const promise = next.fn(controller.signal).finally(() => {
      this.onSettled(key);
    });
    this.running.set(key, { promise, controller });
    promise.then(next.resolve, next.reject);
  }
}

export class SaveSupersededError extends Error {
  constructor(key: string) {
    super(`save superseded for ${key}`);
    this.name = "SaveSupersededError";
  }
}
