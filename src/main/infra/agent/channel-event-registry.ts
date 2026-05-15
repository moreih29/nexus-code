/**
 * Shared subscription registry for channel implementations that fan out an
 * upstream emitter (a pipe, an inner channel) to caller-supplied callbacks.
 *
 * The registry keeps one fan-out subscription on the upstream per event,
 * regardless of how many channel-level callbacks are listening. When the
 * last channel callback for an event unsubscribes, the upstream
 * subscription is released — without that, repeated subscribe/unsubscribe
 * cycles on the channel would leave one fan-out wrapper per cycle attached
 * to the upstream and accumulate forever.
 *
 * Two callers share this:
 *   - `reconnecting-process-channel.ts` rebinds the registry on reconnect
 *     so the same channel-level callbacks transparently flow off the new
 *     pipe.
 *   - `createAuthenticatedSshChannel` in `ssh-channel.ts` attaches the
 *     registry to the inner channel once authentication completes, while
 *     subscriptions registered before that point still get the upstream
 *     dispose released on their channel-level unsubscribe.
 */

import type { ChannelEventCallback } from "./channel";

interface EventBucket {
  readonly callbacks: Set<ChannelEventCallback>;
  upstreamDispose: (() => void) | null;
}

/**
 * Attaches one upstream subscription for `event` and returns its dispose.
 * Implementations look up `(payload) => registry.emit(event, payload)`
 * on the upstream and return the unsubscribe — `null` is permitted when
 * the upstream is not available yet (e.g. SSH auth still pending).
 */
export type UpstreamAttacher = (event: string) => (() => void) | null;

/**
 * Owns the per-event bucket map. `subscribe` is the channel's `on()`,
 * `emit` is what the upstream forwarder invokes, `rebind` swaps the
 * upstream (used on reconnect / when the inner channel arrives after
 * auth), and `dispose` releases everything during channel teardown.
 */
export class ChannelEventRegistry {
  private readonly buckets = new Map<string, EventBucket>();

  /**
   * Registers `callback` for `event`. On the first subscriber for the event
   * the registry binds the upstream by calling `attach(event)` and storing
   * the returned dispose; subsequent subscribers reuse it. The returned
   * function removes this callback and, when it was the last one, releases
   * the upstream subscription.
   */
  subscribe(
    event: string,
    callback: ChannelEventCallback,
    attach: UpstreamAttacher,
  ): () => void {
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

  /**
   * Re-attaches every live event to a (possibly new) upstream. Used when
   * the underlying transport changes — pipe reconnect, SSH inner channel
   * arrives after auth. Stale dispose handles, if any, are cleared first
   * so the previous upstream is released even if it was still alive.
   */
  rebind(attach: UpstreamAttacher): void {
    for (const [event, bucket] of this.buckets) {
      bucket.upstreamDispose?.();
      bucket.upstreamDispose = attach(event);
    }
  }

  /**
   * Fans an upstream-delivered payload out to every live channel callback
   * registered for `event`. Callbacks are snapshotted before iteration so a
   * callback that unsubscribes itself doesn't perturb the iteration.
   */
  emit(event: string, payload: unknown): void {
    const bucket = this.buckets.get(event);
    if (!bucket) return;
    for (const callback of Array.from(bucket.callbacks)) {
      callback(payload);
    }
  }

  /** Releases every upstream subscription and clears the bucket map. */
  dispose(): void {
    for (const bucket of this.buckets.values()) {
      bucket.upstreamDispose?.();
      bucket.upstreamDispose = null;
    }
    this.buckets.clear();
  }
}
