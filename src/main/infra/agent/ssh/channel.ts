import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "../channel";
import { ChannelEventRegistry } from "../channel/event-registry";
import { createDisposedError, createSshError } from "../pipe";
import {
  type AgentReconnectOptions,
  createReconnectingProcessChannel,
} from "../channel/reconnecting-process-channel";
import { classifyAuthLine } from "./auth";
import {
  type AuthenticateSshControlMasterDependencies,
  authenticateSshControlMaster,
  type SshAuthPromptHandler,
} from "./auth-pty";
import { REMOTE_AGENT_PROTOCOL_MAJOR } from "./ssh-bootstrap/index";
import { type SpawnSshProcess, type SshMasterOptions, spawnSshMaster } from "./master";

/**
 * Back-compat aliases. The SSH channel was the original concrete channel
 * implementation, and existing callers (workspace-manager, fs provider, IPC)
 * import these names. They now resolve to the unified `AgentChannel`
 * shape defined in `channel.ts`.
 */
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

/**
 * Opens an SSH-backed NDJSON request channel to the remote agent. The
 * orchestrator spawns the SSH client (via ssh-master) and composes an NDJSON
 * pipe (pipe) over its stdio, classifying stderr through ssh-auth.
 */
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
    closeError: () => createSshError("ssh.unknown"),
    requestTimeoutMs: dependencies.requestTimeoutMs,
    expectedProtocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
    reconnect: dependencies.reconnect,
  });
}

/**
 * Performs the two-phase interactive auth flow, then delegates all NDJSON work
 * to a normal batch-mode channel connected through the created ControlMaster.
 */
function createAuthenticatedSshChannel(
  options: CreateSshChannelOptions,
  dependencies: SshChannelDependencies,
  promptHandler: SshAuthPromptHandler,
): SshChannel {
  const lifecycleListeners = new Set<ChannelLifecycleCallback>();
  // Subscriptions registered before auth completes hold a `null` upstream
  // dispose; when the inner channel arrives, `events.rebind` swaps in the
  // inner-side handle so the channel-level unsubscribe can release it.
  const events = new ChannelEventRegistry();
  const pendingCalls: Array<{
    readonly method: string;
    readonly params: unknown;
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];

  let disposed = false;
  let inner: SshChannel | null = null;
  let disposeInnerLifecycle: (() => void) | null = null;
  let disposeMaster: (() => void) | null = null;

  // Reached only when no controlPath was provided by the caller — i.e. the
  // bootstrap path was not used and we must authenticate our own ControlMaster.
  const ready = authenticateSshControlMaster(options, promptHandler, {
    ...dependencies.auth,
    spawn: dependencies.auth?.spawn ?? dependencies.spawn,
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
      events.rebind((event) =>
        liveInner.on(event, (payload) => events.emit(event, payload)),
      );
      for (const call of pendingCalls.splice(0)) {
        inner.call(call.method, call.params).then(call.resolve, call.reject);
      }
      return inner.ready.finally(() => {
        if (disposed) return;
      });
    })
    .catch((error) => {
      rejectPendingCalls(error);
      emitLifecycle({
        type: "failure",
        error: error instanceof Error ? error : createSshError("ssh.unknown", error),
      });
      throw error;
    });
  ready.catch(() => {});

  return {
    ready,
    call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
      if (disposed) return Promise.reject(createDisposedError());
      if (inner) return inner.call<TResult>(method, params);
      return new Promise<TResult>((resolve, reject) => {
        pendingCalls.push({ method, params, resolve: resolve as (value: unknown) => void, reject });
      });
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
