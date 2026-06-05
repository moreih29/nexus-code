/**
 * The unified channel abstraction over an agent child process. Two
 * implementations exist:
 *   - `local-channel.ts` — spawns the bundled `agent` binary directly
 *   - `ssh-channel.ts`   — spawns it through an SSH client over stdio
 *
 * Callers depend only on this interface and stay ignorant of the underlying
 * transport. The shape mirrors the original `SshChannel` interface so existing
 * SSH consumers (workspace-manager, fs provider) keep compiling — `SshChannel`
 * is now exported as an alias of `AgentChannel` from `ssh-channel.ts`.
 */
export type ChannelEventCallback = (payload: unknown) => void;
export type ChannelLifecycleCallback = (event: ChannelLifecycleEvent) => void;

/**
 * Lifecycle events emitted to `onLifecycle` subscribers. The terminal events
 * (`exit` / `failure` / `disposed`) fire at most once per channel. The
 * transient `reconnecting` event may fire when the channel detects it has
 * lost its current process and is about to retry; it does NOT imply the
 * channel is dead — a subsequent successful reconnect leaves the channel
 * ready again. Subscribers that own session-style state (e.g. PTY shells,
 * which cannot be transparently respawned) should treat `reconnecting` as a
 * session-death signal even though the channel itself may recover.
 *
 * Transient heartbeat quality events:
 *   - `degraded`: fired after 1 missed heartbeat (advertisedInterval × 1).
 *     The channel is still alive; the manager should surface an "unstable"
 *     indicator rather than killing sessions. Cleared by `degraded-recovered`.
 *   - `degraded-recovered`: fired when a heartbeat arrives after a `degraded`
 *     event. The manager should clear the unstable indicator.
 *
 * Reattach epoch events:
 *   - `held-then-expired`: fired on reconnect when the new agent's epoch does
 *     not match the epoch seen at the previous ready. Signals that the daemon
 *     was replaced during the outage — sessions cannot be reattached and must
 *     be treated as expired. Distinct from `failure` (which indicates the
 *     channel itself is dead) and `reconnecting` (which is recoverable).
 *     The manager (task 13) should consume this to expire held PTYs and show
 *     the "session expired" empty state.
 */
export type ChannelLifecycleEvent =
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: "failure"; readonly error: Error }
  | {
      readonly type: "reconnecting";
      readonly cause: Error | null;
      /**
       * True when the channel has previously completed a ready handshake that
       * included an agentEpoch > 0 (protocol v2 daemon). When false the agent
       * is a legacy (v1) or local process and PTY sessions should be killed
       * immediately rather than placed on hold, because there is no daemon
       * that can survive a dialer reconnect.
       */
      readonly hadEpoch: boolean;
    }
  | { readonly type: "disposed" }
  | { readonly type: "degraded" }
  | { readonly type: "degraded-recovered" }
  | {
      readonly type: "held-then-expired";
      /** Epoch seen at the previous ready (0 = no previous epoch). */
      readonly previousEpoch: number;
      /** New epoch from the reconnected agent. */
      readonly newEpoch: number;
    }
  | {
      /**
       * Fired after a successful reconnect where the new agent's epoch matches
       * the previous epoch — the daemon survived the outage and PTY sessions
       * can be restored via session.list + pty.replay.
       */
      readonly type: "ready";
    };

/**
 * NDJSON request channel to an agent child. `ready` settles when the
 * server emits its boot frame (or, for older servers, when the first valid
 * response/event arrives). `call` rejects with an Error whose `code` is the
 * server's wire code on remote failures, or a transport `SshErrorCode` on
 * pipe-level failures. `fire` sends a one-way notification — the frame is
 * written to the agent but the caller does not await the agent's ack response;
 * use this for LSP notifications (didOpen/didChange/didSave/didClose) that must
 * not stall the request pipeline while waiting for a semantically-empty ack.
 * `on` subscribes to server-pushed events. `onLifecycle` reports exit /
 * failure / dispose transitions. `dispose` tears the channel down — idempotent
 * and synchronous from the caller's view.
 */
export interface AgentChannel {
  readonly ready: Promise<void>;
  call<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  /**
   * Sends a fire-and-forget notification to the agent. The frame is written
   * to stdin and the pending slot is registered so the agent's ack response is
   * absorbed cleanly, but this method returns immediately without awaiting the
   * ack. This avoids holding the outMu on the Go side and occupying
   * pendingRequests slots for the duration of a round-trip on every keystroke.
   */
  fire(method: string, params?: unknown): void;
  on(event: string, callback: ChannelEventCallback): () => void;
  onLifecycle(callback: ChannelLifecycleCallback): () => void;
  dispose(): void;
}
