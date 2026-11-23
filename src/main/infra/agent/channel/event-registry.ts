import type { ChannelEventCallback } from "./index";

interface EventBucket {
  readonly callbacks: Set<ChannelEventCallback>;
  upstreamDispose: (() => void) | null;
}

export type UpstreamAttacher = (event: string) => (() => void) | null;

export class ChannelEventRegistry {
  private readonly buckets = new Map<string, EventBucket>();

  subscribe(event: string, callback: ChannelEventCallback, attach: UpstreamAttacher): () => void {
    let bucket = this.buckets.get(event);
    if (!bucket) {
      bucket = { callbacks: new Set<ChannelEventCallback>(), upstreamDispose: null };
      this.buckets.set(event, bucket);
      bucket.upstreamDispose = attach(event);
    }
    bucket.callbacks.add(callback);
    return () => {
      const current = this.buckets.get(event);
      if (!current) return;
      current.callbacks.delete(callback);
      if (current.callbacks.size === 0) {
        current.upstreamDispose?.();
        current.upstreamDispose = null;
        this.buckets.delete(event);
      }
    };
  }

  rebind(attach: UpstreamAttacher): void {
    for (const [event, bucket] of this.buckets) {
      bucket.upstreamDispose?.();
      bucket.upstreamDispose = attach(event);
    }
  }

  emit(event: string, payload: unknown): void {
    const bucket = this.buckets.get(event);
    if (!bucket) return;
    for (const callback of Array.from(bucket.callbacks)) {
      callback(payload);
    }
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      bucket.upstreamDispose?.();
      bucket.upstreamDispose = null;
    }
    this.buckets.clear();
  }
}
