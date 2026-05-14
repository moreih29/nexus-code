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
 * Lifecycle events emitted to `onLifecycle` subscribers. Implementations must
 * emit at most one terminal event per channel — `exit` for a clean drain,
 * `failure` for an error path, or `disposed` when the owner called `dispose`.
 */
export type ChannelLifecycleEvent =
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: "failure"; readonly error: Error }
  | { readonly type: "disposed" };

/**
 * NDJSON request channel to an agent child. `ready` settles when the
 * server emits its boot frame (or, for older servers, when the first valid
 * response/event arrives). `call` rejects with an Error whose `code` is the
 * server's wire code on remote failures, or a transport `SshErrorCode` on
 * pipe-level failures. `on` subscribes to server-pushed events (Round 3).
 * `onLifecycle` reports exit / failure / dispose transitions. `dispose`
 * tears the channel down — idempotent and synchronous from the caller's view.
 */
export interface AgentChannel {
  readonly ready: Promise<void>;
  call<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  on(event: string, callback: ChannelEventCallback): () => void;
  onLifecycle(callback: ChannelLifecycleCallback): () => void;
  dispose(): void;
}
