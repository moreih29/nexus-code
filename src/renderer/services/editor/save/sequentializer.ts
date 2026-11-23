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
