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
 * Disposal lets stdin EOF run the local agent's shutdown hooks before the
 * hard-kill fallback. Transport failures and clean closes surface through the
 * shared channel lifecycle.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENT_PROTOCOL_VERSION } from "../../../../shared/agent/envelope";
import { opaqueTag } from "../../../../shared/log/limit";
import { createSshError } from "../pipe";
import type { AgentChannel } from "./index";
import {
  type AgentReconnectOptions,
  createReconnectingProcessChannel,
} from "./reconnecting-process-channel";

// Allow the Go host's 75 ms request drain and 3 s of shutdown hooks to finish.
const LOCAL_AGENT_SHUTDOWN_MS = 3_500;
const pendingLocalShutdowns = new Set<Promise<void>>();

/** Waits for local agents already being disposed, including removed workspaces. */
export async function waitForLocalAgentShutdowns(): Promise<void> {
  await Promise.all(pendingLocalShutdowns);
}

/** Tracks EOF-driven shutdown until the agent closes or the kill deadline. */
function finishLocalAgentShutdown(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const shutdown = new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } finally {
        finish();
      }
    }, LOCAL_AGENT_SHUTDOWN_MS);
    timer.unref?.();
    child.once("close", finish);
  });
  pendingLocalShutdowns.add(shutdown);
  void shutdown.then(() => pendingLocalShutdowns.delete(shutdown));
}

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
    disposeChild: finishLocalAgentShutdown,
    // Local stderr is not classified — the binary writes only human-readable
    // hints (e.g. usage), and terminal failures surface via exit code below.
    classifyStderr: () => null,
    logLabel: `local:${opaqueTag(options.rootPath)}`,
    closeError: (wasReady) =>
      createSshError(wasReady ? "transport.unknown" : "server.spawn-failed"),
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
  // Self-healing against a regression where the packaging step (electron-builder extraResources copy)
  // drops the executable bit of the bundled binary. Applies only to absolute-path binaries.
  // The dev fallback (`go run`) has a relative binaryPath such as "go", so it is skipped. If the
  // permission is already right or the path is read-only, it is ignored as best-effort.
  if (path.isAbsolute(binaryPath)) {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {
      // best-effort: afterPack may already have ensured +x, or Resources may be read-only.
    }
  }
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
