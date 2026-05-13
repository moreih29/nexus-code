/**
 * Local agent channel. Spawns the bundled `agent` binary as a
 * child process, wires its stdio through the shared NDJSON pipe, and exposes
 * the result as an `AgentChannel` — the same interface the SSH channel
 * surfaces, so callers stay transport-agnostic.
 *
 * The binary path is provided by the caller (not resolved here) because
 * resolution differs between dev (`go build` to a tmp dir, used by the
 * integration test), packaged production (under `dist/agent/<plat>/`),
 * and tests (ad-hoc). Keeping path resolution outside this module also makes
 * the channel a thin glue layer that is straightforward to fake in unit tests.
 *
 * Lifecycle mirrors `ssh-channel`: a SIGTERM-then-SIGKILL dispose path, a
 * `failure` lifecycle event on spawn or terminal pipe errors, and an `exit`
 * event for clean closes that happened after `ready` settled.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { AGENT_PROTOCOL_VERSION } from "../../shared/protocol/agent/envelope";
import type {
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
  AgentChannel,
} from "./channel";
import { createNdjsonPipe, createSshError, type NdjsonPipe, type SshError } from "./pipe";

const DISPOSE_KILL_GRACE_MS = 100;

export interface CreateLocalChannelOptions {
  /** Absolute path to the `agent` binary. Caller resolves dev/prod. */
  readonly binaryPath: string;
  /** Workspace root passed as the binary's first positional argument. */
  readonly rootPath: string;
  /** Optional command arguments placed before rootPath, used by dev fallbacks. */
  readonly argsPrefix?: readonly string[];
  /** Optional working directory for dev command fallbacks. */
  readonly cwd?: string;
  /** Optional env overlay; merged on top of `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Per-request timeout override; defaults to the pipe's 30s setting. */
  readonly requestTimeoutMs?: number;
}

/**
 * Indirection hook so tests can swap in a fake `spawn` without touching the
 * production code path. Defaults to `node:child_process.spawn`.
 */
export type SpawnLocalProcess = (
  binaryPath: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface LocalChannelDependencies {
  readonly spawn?: SpawnLocalProcess;
}

/**
 * Opens a local NDJSON channel to a freshly spawned agent child.
 * Returns synchronously; await `channel.ready` before the first `call`.
 */
export function createLocalChannel(
  options: CreateLocalChannelOptions,
  dependencies: LocalChannelDependencies = {},
): AgentChannel {
  const lifecycleListeners = new Set<ChannelLifecycleCallback>();
  const spawnImpl = dependencies.spawn ?? defaultSpawn;
  const env = options.env ? { ...process.env, ...options.env } : undefined;

  const child = spawnImpl(options.binaryPath, [...(options.argsPrefix ?? []), options.rootPath], {
    cwd: options.cwd,
    env,
  });

  let disposed = false;
  let closed = false;
  let failed = false;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const pipe: NdjsonPipe = createNdjsonPipe({
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    // Local stderr is not classified — the binary writes only human-readable
    // hints (e.g. usage), and terminal failures surface via exit code below.
    classifyStderr: () => null,
    onTerminalError: handlePipeFailure,
    requestTimeoutMs: options.requestTimeoutMs,
    expectedProtocolMajor: protocolMajor(AGENT_PROTOCOL_VERSION),
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
    handleHardFailure(createSshError(wasReady ? "ssh.unknown" : "server.spawn-failed"));
  });

  return {
    ready: pipe.ready,
    call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
      return pipe.call<TResult>(method, params);
    },
    on(event: string, callback: ChannelEventCallback): () => void {
      return pipe.on(event, callback);
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

  /** Reacts to a pipe-detected terminal error (bad frame, protocol mismatch). */
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
    const wrapped = createSshError("server.spawn-failed", error);
    pipe.fail(wrapped);
    emitLifecycle({ type: "failure", error: wrapped });
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

  /** Starts the hard-kill timer used when the child ignores disposal. */
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

  /** Delivers one lifecycle event to currently subscribed callbacks. */
  function emitLifecycle(event: ChannelLifecycleEvent): void {
    for (const callback of Array.from(lifecycleListeners)) {
      callback(event);
    }
  }
}

/** Production `spawn` adapter — kept as a named function for stack readability. */
function defaultSpawn(
  binaryPath: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return spawn(binaryPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

/** Extracts the major-version segment used for handshake compatibility. */
function protocolMajor(version: string): string {
  return version.split(".", 1)[0] ?? version;
}
