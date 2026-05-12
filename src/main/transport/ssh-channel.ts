import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { classifyAuthLine } from "./ssh-auth";
import { type SpawnSshProcess, type SshMasterOptions, spawnSshMaster } from "./ssh-master";
import { createNdjsonPipe, createSshError, type NdjsonPipe, type SshError } from "./ssh-pipe";

const DISPOSE_KILL_GRACE_MS = 100;

type SshEventCallback = (payload: unknown) => void;
type SshLifecycleCallback = (event: SshChannelLifecycleEvent) => void;

export type CreateSshChannelOptions = SshMasterOptions;

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
