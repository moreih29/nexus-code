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
import { AGENT_PROTOCOL_VERSION } from "../../../shared/protocol/agent/envelope";
import type { AgentChannel } from "./channel";
import { createSshError } from "./pipe";
import {
  type AgentReconnectOptions,
  createReconnectingProcessChannel,
} from "./reconnecting-process-channel";

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
  /** Optional reconnect queue/backoff overrides, mainly used by focused tests. */
  readonly reconnect?: AgentReconnectOptions;
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
  const spawnImpl = dependencies.spawn ?? defaultSpawn;
  const env = options.env ? { ...process.env, ...options.env } : undefined;

  return createReconnectingProcessChannel({
    spawn: () =>
      spawnImpl(options.binaryPath, [...(options.argsPrefix ?? []), options.rootPath], {
        cwd: options.cwd,
        env,
      }),
    // Local stderr is not classified — the binary writes only human-readable
    // hints (e.g. usage), and terminal failures surface via exit code below.
    classifyStderr: () => null,
    closeError: (wasReady) => createSshError(wasReady ? "transport.unknown" : "server.spawn-failed"),
    requestTimeoutMs: options.requestTimeoutMs,
    expectedProtocolMajor: protocolMajor(AGENT_PROTOCOL_VERSION),
    reconnect: options.reconnect,
  });
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
