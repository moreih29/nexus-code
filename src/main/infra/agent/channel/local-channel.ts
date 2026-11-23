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

const LOCAL_AGENT_SHUTDOWN_MS = 3_500;
const pendingLocalShutdowns = new Set<Promise<void>>();

export async function waitForLocalAgentShutdowns(): Promise<void> {
  await Promise.all(pendingLocalShutdowns);
}

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
  readonly binaryPath: string;
  readonly rootPath: string;
  readonly argsPrefix?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly reconnect?: AgentReconnectOptions;
}

export type SpawnLocalProcess = (
  binaryPath: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface LocalChannelDependencies {
  readonly spawn?: SpawnLocalProcess;
}

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
    classifyStderr: () => null,
    logLabel: `local:${opaqueTag(options.rootPath)}`,
    closeError: (wasReady) =>
      createSshError(wasReady ? "transport.unknown" : "server.spawn-failed"),
    requestTimeoutMs: options.requestTimeoutMs,
    expectedProtocolMajor: protocolMajor(AGENT_PROTOCOL_VERSION),
    reconnect: options.reconnect,
  });
}

function defaultSpawn(
  binaryPath: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  if (path.isAbsolute(binaryPath)) {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {}
  }
  return spawn(binaryPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

function protocolMajor(version: string): string {
  return version.split(".", 1)[0] ?? version;
}
