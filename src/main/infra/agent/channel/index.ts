export type ChannelEventCallback = (payload: unknown) => void;
export type ChannelLifecycleCallback = (event: ChannelLifecycleEvent) => void;

export type ChannelLifecycleEvent =
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: "failure"; readonly error: Error }
  | {
      readonly type: "reconnecting";
      readonly cause: Error | null;
      readonly hadEpoch: boolean;
    }
  | { readonly type: "disposed" }
  | { readonly type: "degraded" }
  | { readonly type: "degraded-recovered" }
  | {
      readonly type: "held-then-expired";
      readonly previousEpoch: number;
      readonly newEpoch: number;
    }
  | {
      readonly type: "ready";
    };

export interface AgentCallOptions {
  readonly timeoutMs?: number;
}

export interface AgentChannel {
  readonly ready: Promise<void>;
  call<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: AgentCallOptions,
  ): Promise<TResult>;
  fire(method: string, params?: unknown): void;
  on(event: string, callback: ChannelEventCallback): () => void;
  onLifecycle(callback: ChannelLifecycleCallback): () => void;
  dispose(): void;
}
