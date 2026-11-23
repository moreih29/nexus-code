import { createAbortError, throwIfAborted } from "../../../../../shared/abort";
import { gitMissingError, unknownGitError } from "../../domain/error";

type QueueResult<T> = { done: false; value: T } | { done: true };

export class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (value: QueueResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown;

  push(value: T): void {
    if (this.closed || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<QueueResult<T>> {
    if (this.values.length > 0) {
      return Promise.resolve({ done: false, value: this.values.shift() as T });
    }
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.closed) {
      return Promise.resolve({ done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

export { createAbortError, throwIfAborted };

export function normalizeAgentGitError(
  error: unknown,
  bin: string,
  args: readonly string[],
): unknown {
  if (error instanceof Error && /git executable not found/i.test(error.message)) {
    return gitMissingError(bin, args, error);
  }
  if (error instanceof Error) {
    return unknownGitError(error.message, args, error);
  }
  return error;
}
