interface PendingEntry<TResult> {
  resolve: (value: TResult) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

export class PendingRequestMap<TKey, TResult> {
  private readonly pending = new Map<TKey, PendingEntry<TResult>>();

  register({
    key,
    timeoutMs,
    onTimeout,
  }: {
    key: TKey;
    timeoutMs: number;
    onTimeout?: () => Error;
  }): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        const error = onTimeout?.() ?? new Error(`Request timed out (key: ${String(key)})`);
        reject(error);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      this.pending.set(key, { resolve, reject, timer });
    });
  }

  resolve(key: TKey, value: TResult): boolean {
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
    entry.resolve(value);
    return true;
  }

  reject(key: TKey, error: Error): boolean {
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
    entry.reject(error);
    return true;
  }

  clearAll(reason: string): void {
    const error = new Error(reason);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
      entry.reject(error);
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }

  has(key: TKey): boolean {
    return this.pending.has(key);
  }
}
