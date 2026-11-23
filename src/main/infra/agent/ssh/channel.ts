import { opaqueTag } from "../../../../shared/log/limit";
import type {
  AgentCallOptions,
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../channel";
import { ChannelEventRegistry } from "../channel/event-registry";
import {
  type AgentReconnectOptions,
  type ChannelCloseContext,
  createReconnectingProcessChannel,
} from "../channel/reconnecting-process-channel";
import { createDisposedError, createSshError } from "../pipe";
import { classifyAuthLine } from "./auth";
import {
  type AuthenticateSshControlMasterDependencies,
  authenticateSshControlMaster,
  type SshAuthPromptHandler,
} from "./auth-pty";
import { type SpawnSshProcess, type SshMasterOptions, spawnSshMaster } from "./master";
import { REMOTE_AGENT_PROTOCOL_MAJOR } from "./ssh-bootstrap/index";

export type SshChannel = AgentChannel;
export type SshChannelLifecycleEvent = ChannelLifecycleEvent;

export type CreateSshChannelOptions = SshMasterOptions & {
  readonly authMode?: "interactive" | "key-only";
};

export interface SshChannelDependencies {
  readonly spawn?: SpawnSshProcess;
  readonly auth?: AuthenticateSshControlMasterDependencies;
  readonly promptHandler?: SshAuthPromptHandler;
  readonly requestTimeoutMs?: number;
  readonly reconnect?: AgentReconnectOptions;
}

export function formatCloseDiagnostic(context?: ChannelCloseContext): string | undefined {
  if (!context) return undefined;
  const parts: string[] = [];
  if (context.code !== undefined && context.code !== null) {
    parts.push(`exit code=${context.code}`);
  }
  if (context.signal) {
    parts.push(`signal=${context.signal}`);
  }
  const stderrTail = context.stderrTail?.trim();
  if (stderrTail) {
    parts.push(`stderr=${stderrTail}`);
  }
  return parts.length > 0 ? `agent process closed (${parts.join(" ")})` : undefined;
}

export function createSshChannel(
  options: CreateSshChannelOptions,
  dependencies: SshChannelDependencies = {},
): SshChannel {
  const promptHandler = dependencies.promptHandler;
  if (options.authMode === "interactive" && promptHandler && !options.controlPath) {
    return createAuthenticatedSshChannel(options, dependencies, promptHandler);
  }

  return createReconnectingProcessChannel({
    spawn: () =>
      spawnSshMaster(options, {
        spawn: dependencies.spawn,
      }),
    classifyStderr: classifyAuthLine,
    logLabel: `ssh:${opaqueTag(options.host)}`,
    closeError: (_wasReady, context) =>
      createSshError("ssh.unknown", formatCloseDiagnostic(context)),
    requestTimeoutMs: dependencies.requestTimeoutMs,
    expectedProtocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
    reconnect: dependencies.reconnect,
    isFatalReconnectError: (error) => error.code === "ssh.auth-failed",
  });
}

function createAuthenticatedSshChannel(
  options: CreateSshChannelOptions,
  dependencies: SshChannelDependencies,
  promptHandler: SshAuthPromptHandler,
): SshChannel {
  const lifecycleListeners = new Set<ChannelLifecycleCallback>();
  const events = new ChannelEventRegistry();
  const pendingCalls: Array<{
    readonly method: string;
    readonly params: unknown;
    readonly options?: AgentCallOptions;
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];

  let disposed = false;
  let inner: SshChannel | null = null;
  let disposeInnerLifecycle: (() => void) | null = null;
  let disposeMaster: (() => void) | null = null;

  const auth = new AbortController();
  const ready = authenticateSshControlMaster(options, promptHandler, {
    ...dependencies.auth,
    spawn: dependencies.auth?.spawn ?? dependencies.spawn,
    signal: auth.signal,
  })
    .then((master) => {
      if (disposed) {
        master.dispose();
        throw createDisposedError();
      }
      disposeMaster = () => master.dispose();
      inner = createSshChannel(
        { ...options, controlPath: master.controlPath },
        {
          spawn: dependencies.spawn,
          requestTimeoutMs: dependencies.requestTimeoutMs,
          reconnect: dependencies.reconnect,
        },
      );
      disposeInnerLifecycle = inner.onLifecycle((event) => emitLifecycle(event));
      const liveInner = inner;
      events.rebind((event) => liveInner.on(event, (payload) => events.emit(event, payload)));
      for (const call of pendingCalls.splice(0)) {
        inner.call(call.method, call.params, call.options).then(call.resolve, call.reject);
      }
      return inner.ready.finally(() => {
        if (disposed) return;
      });
    })
    .catch((error) => {
      rejectPendingCalls(error);
      if (disposed) throw error;
      emitLifecycle({
        type: "failure",
        error: error instanceof Error ? error : createSshError("ssh.unknown", error),
      });
      throw error;
    });
  ready.catch(() => {});

  return {
    ready,
    call<TResult = unknown>(
      method: string,
      params?: unknown,
      options?: AgentCallOptions,
    ): Promise<TResult> {
      if (disposed) return Promise.reject(createDisposedError());
      if (inner) return inner.call<TResult>(method, params, options);
      return new Promise<TResult>((resolve, reject) => {
        pendingCalls.push({
          method,
          params,
          options,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
    },
    fire(method: string, params?: unknown): void {
      if (disposed || !inner) return;
      inner.fire(method, params);
    },
    on(event: string, callback: ChannelEventCallback): () => void {
      return events.subscribe(event, callback, (e) => {
        const liveInner = inner;
        if (!liveInner) return null;
        return liveInner.on(e, (payload) => events.emit(e, payload));
      });
    },
    onLifecycle(callback: ChannelLifecycleCallback): () => void {
      lifecycleListeners.add(callback);
      return () => {
        lifecycleListeners.delete(callback);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      auth.abort(createDisposedError());
      rejectPendingCalls(createDisposedError());
      disposeInnerLifecycle?.();
      inner?.dispose();
      disposeMaster?.();
    },
  };

  function rejectPendingCalls(error: Error): void {
    for (const call of pendingCalls.splice(0)) call.reject(error);
  }

  function emitLifecycle(event: SshChannelLifecycleEvent): void {
    for (const callback of Array.from(lifecycleListeners)) callback(event);
  }
}
