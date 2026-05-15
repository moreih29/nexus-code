/**
 * Per-URI debouncer for the LSP `publishDiagnostics` notification.
 *
 * LSP 3.17 §3.18 makes each `publishDiagnostics` for a URI fully replace
 * the previous set, so during a burst (formatter running, save-on-change
 * cascades) only the most recent payload matters — earlier ones can be
 * dropped safely. This module captures that policy in one place so the
 * host class stays focused on server lifecycle and request routing.
 *
 * Policy:
 *   - Leading-edge bypass: when a URI has been quiet for at least
 *     `leadingIdleMs`, emit immediately so squiggles stay responsive
 *     under normal steady-state editing.
 *   - Trailing-edge debounce: during a burst, replace the stored payload
 *     with the latest and reschedule the timer from zero. The timer
 *     callback emits the most recent payload.
 *   - Flush: emit a pending payload immediately (used by didClose to give
 *     the renderer a final consistent state for the closing URI).
 *   - Clear: cancel without emitting (used on server exit/dispose).
 */

interface DebounceState {
  timer: ReturnType<typeof setTimeout> | null;
  latestPayload: { uri: string; diagnostics: unknown[] };
  lastEmittedAt: number;
}

export interface DiagnosticsDebouncerOptions {
  /** How long the trailing-edge timer waits before emitting. */
  readonly debounceMs: number;
  /** How long a URI must be quiet before the next emit goes through immediately. */
  readonly leadingIdleMs: number;
  /** Sink for emitted payloads — typically `host.emit("diagnostics", ...)`. */
  readonly emit: (payload: { uri: string; diagnostics: unknown[] }) => void;
  /** Resolves the owning server tuple for a URI so `clearForServer` can scope correctly. */
  readonly uriOwner: (uri: string) => { workspaceId: string; languageId: string } | null;
}

/**
 * Holds the per-URI debounce state, owns the timer handles, and routes
 * `schedule` / `flush` / `clearForServer` / `clearAll` against the
 * caller-supplied emit sink.
 */
export class DiagnosticsDebouncer {
  private readonly state = new Map<string, DebounceState>();

  constructor(private readonly options: DiagnosticsDebouncerOptions) {}

  /** Per-URI trailing-edge debounce with leading-edge bypass for idle URIs. */
  schedule(payload: { uri: string; diagnostics: unknown[] }): void {
    const { uri } = payload;
    const current = this.state.get(uri);
    const now = Date.now();

    if (current === undefined || current.lastEmittedAt + this.options.leadingIdleMs < now) {
      if (current?.timer !== null && current?.timer !== undefined) {
        clearTimeout(current.timer);
      }
      this.options.emit(payload);
      this.state.set(uri, { timer: null, latestPayload: payload, lastEmittedAt: now });
      return;
    }

    if (current.timer !== null) {
      clearTimeout(current.timer);
    }
    const timer = setTimeout(() => {
      const pending = this.state.get(uri);
      if (!pending) return;
      this.options.emit(pending.latestPayload);
      this.state.set(uri, {
        timer: null,
        latestPayload: pending.latestPayload,
        lastEmittedAt: Date.now(),
      });
    }, this.options.debounceMs);
    this.state.set(uri, {
      timer,
      latestPayload: payload,
      lastEmittedAt: current.lastEmittedAt,
    });
  }

  /**
   * Emit the pending payload for `uri` immediately and cancel the timer.
   * When the timer is null the leading-edge path already emitted, so this
   * call is a no-op for that URI.
   */
  flush(uri: string): void {
    const current = this.state.get(uri);
    if (!current) return;
    if (current.timer !== null) {
      clearTimeout(current.timer);
      this.options.emit(current.latestPayload);
    }
    this.state.delete(uri);
  }

  /**
   * Cancel pending timers for URIs owned by the given server without
   * emitting — used on server crash/exit so the renderer does not see a
   * stale "diagnostics still arriving" for a server that is gone.
   */
  clearForServer(workspaceId: string, languageId: string): void {
    for (const [uri, current] of this.state) {
      const owner = this.options.uriOwner(uri);
      if (owner && owner.workspaceId === workspaceId && owner.languageId === languageId) {
        if (current.timer !== null) {
          clearTimeout(current.timer);
        }
        this.state.delete(uri);
      }
    }
  }

  /** Cancel all pending timers — used by host dispose. */
  clearAll(): void {
    for (const current of this.state.values()) {
      if (current.timer !== null) {
        clearTimeout(current.timer);
      }
    }
    this.state.clear();
  }
}
