import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { classifyAuthLine } from "./ssh-auth";
import {
  authenticateSshControlMaster,
  type AuthenticateSshControlMasterDependencies,
  type SshAuthPromptHandler,
} from "./ssh-auth-pty";
import { type SpawnSshProcess, type SshMasterOptions, spawnSshMaster } from "./ssh-master";
import {
  createDisposedError,
  createNdjsonPipe,
  createSshError,
  type NdjsonPipe,
  type SshError,
} from "./ssh-pipe";
import { REMOTE_SERVER_PROTOCOL_MAJOR } from "./ssh-bootstrap";

const DISPOSE_KILL_GRACE_MS = 100;

type SshEventCallback = (payload: unknown) => void;
type SshLifecycleCallback = (event: SshChannelLifecycleEvent) => void;

export type CreateSshChannelOptions = SshMasterOptions & {
  readonly authMode?: "interactive" | "key-only";
};

export interface SshChannel {
  /**
   * Resolves when the remote server emits its startup ready frame. If a caller
   * sends a request before awaiting this promise, the first valid response or
   * event also marks the channel ready for compatibility with older servers.
   */
  readonly ready: Promise<void>;
  call<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  on(event: string, callback: SshEventCallback): () => void;
  onLifecycle(callback: SshLifecycleCallback): () => void;
  dispose(): void;
}

export type SshChannelLifecycleEvent =
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: "failure"; readonly error: Error }
  | { readonly type: "disposed" };

export interface SshChannelDependencies {
  readonly spawn?: SpawnSshProcess;
  readonly auth?: AuthenticateSshControlMasterDependencies;
  readonly promptHandler?: SshAuthPromptHandler;
  readonly requestTimeoutMs?: number;
}

/**
 * Opens an SSH-backed NDJSON request channel to the remote server. The
 * orchestrator spawns the SSH client (via ssh-master) and composes an NDJSON
 * pipe (ssh-pipe) over its stdio, classifying stderr through ssh-auth.
 */
export function createSshChannel(
  options: CreateSshChannelOptions,
  dependencies: SshChannelDependencies = {},
): SshChannel {
  const promptHandler = dependencies.promptHandler;
  if (options.authMode === "interactive" && promptHandler && !options.controlPath) {
    return createAuthenticatedSshChannel(options, dependencies, promptHandler);
  }

  const lifecycleListeners = new Set<SshLifecycleCallback>();
  const child: ChildProcessWithoutNullStreams = spawnSshMaster(options, {
    spawn: dependencies.spawn,
  });

  let disposed = false;
  let closed = false;
  let failed = false;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const pipe: NdjsonPipe = createNdjsonPipe({
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    classifyStderr: classifyAuthLine,
    onTerminalError: handlePipeFailure,
    requestTimeoutMs: dependencies.requestTimeoutMs,
    expectedProtocolMajor: REMOTE_SERVER_PROTOCOL_MAJOR,
  });

  child.on("error", (error) => {
    handleSpawnError(error);
  });

  child.on("close", (code, signal) => {
    closed = true;
    clearForceKillTimer();
    const { wasReady } = pipe.notifyClose();

    if (disposed || failed) return;
    if (code === 0 && wasReady) {
      emitLifecycle({ type: "exit", code, signal });
      return;
    }
    handleHardFailure(createSshError("ssh.unknown"));
  });

  return {
    ready: pipe.ready,
    call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
      return pipe.call<TResult>(method, params);
    },
    on(event: string, callback: SshEventCallback): () => void {
      return pipe.on(event, callback);
    },
    onLifecycle(callback: SshLifecycleCallback): () => void {
      lifecycleListeners.add(callback);
      return () => {
        lifecycleListeners.delete(callback);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pipe.dispose();
      if (!failed) {
        emitLifecycle({ type: "disposed" });
      }
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      terminateChild();
    },
  };

  /** Reacts to a pipe-detected terminal error (bad frame, classified stderr). */
  function handlePipeFailure(error: SshError): void {
    if (failed) return;
    failed = true;
    emitLifecycle({ type: "failure", error });
    terminateChild();
  }

  /** Reacts to spawn errors emitted by the child process itself. */
  function handleSpawnError(error: unknown): void {
    if (failed) return;
    failed = true;
    const sshError = createSshError("server.spawn-failed", error);
    pipe.fail(sshError);
    emitLifecycle({ type: "failure", error: sshError });
  }

  /** Reacts to a non-clean close or a clean close before ready settled. */
  function handleHardFailure(error: SshError): void {
    if (failed) return;
    failed = true;
    pipe.fail(error);
    emitLifecycle({ type: "failure", error });
  }

  /** Sends SIGTERM now and schedules the 100ms SIGKILL fallback. */
  function terminateChild(): void {
    if (closed || child.killed) return;
    child.kill("SIGTERM");
    scheduleForceKill();
  }

  /** Starts the hard-kill timer used when ssh ignores disposal. */
  function scheduleForceKill(): void {
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, DISPOSE_KILL_GRACE_MS);
    forceKillTimer.unref?.();
  }

  /** Clears the hard-kill timer after the child exits. */
  function clearForceKillTimer(): void {
    if (!forceKillTimer) return;
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }

  /** Delivers one transport lifecycle event to currently subscribed callbacks. */
  function emitLifecycle(event: SshChannelLifecycleEvent): void {
    for (const callback of Array.from(lifecycleListeners)) {
      callback(event);
    }
  }
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
  const lifecycleListeners = new Set<SshLifecycleCallback>();
  const eventListeners = new Map<string, Set<SshEventCallback>>();
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
        { spawn: dependencies.spawn, requestTimeoutMs: dependencies.requestTimeoutMs },
      );
      disposeInnerLifecycle = inner.onLifecycle((event) => emitLifecycle(event));
      for (const [event, callbacks] of eventListeners) {
        for (const callback of callbacks) inner.on(event, callback);
      }
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
    on(event: string, callback: SshEventCallback): () => void {
      let callbacks = eventListeners.get(event);
      if (!callbacks) {
        callbacks = new Set<SshEventCallback>();
        eventListeners.set(event, callbacks);
      }
      callbacks.add(callback);
      const disposeInnerEvent = inner?.on(event, callback) ?? null;
      return () => {
        callbacks?.delete(callback);
        disposeInnerEvent?.();
      };
    },
    onLifecycle(callback: SshLifecycleCallback): () => void {
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
