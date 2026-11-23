import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { opaqueTag } from "../../../../shared/log/limit";
import type { AgentChannel } from "../channel";
import {
  type AgentReconnectOptions,
  createReconnectingProcessChannel,
} from "../channel/reconnecting-process-channel";
import { collectProcess } from "../collect-process";
import { createSshError } from "../pipe";
import { formatCloseDiagnostic } from "../ssh/channel";
import {
  type EnsureRemoteAgentResult,
  type EnsureRemoteLspServerResult,
  ensureRemoteAgent,
  ensureRemoteLspServer,
  type LspBootstrapProgressEvent,
  REMOTE_AGENT_PROTOCOL_MAJOR,
  type RemoteAgentPlatform,
  type SshBootstrapRunner,
} from "../ssh/ssh-bootstrap";

const WSL_EXE = "wsl.exe";
const WSL_COMMAND_TIMEOUT_MS = 120_000;
const WSL_LIST_TIMEOUT_MS = 10_000;

export type SpawnWslProcess = (
  distro: string,
  argv: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface WslAgentOptions {
  readonly distro: string;
  readonly remotePath: string;
  readonly signal?: AbortSignal;
  readonly workspaceId?: string;
  readonly cachedRemoteArch?: RemoteAgentPlatform;
}

export interface WslLspServerOptions extends WslAgentOptions {
  readonly binaryName: string;
  readonly languageId?: string;
}

export interface WslBootstrapDependencies {
  readonly runner?: SshBootstrapRunner;
  readonly onProgress?: (event: LspBootstrapProgressEvent) => void;
}

export interface CreateWslChannelOptions {
  readonly distro: string;
  readonly remoteCommand: string;
}

export interface WslChannelDependencies {
  readonly spawn?: SpawnWslProcess;
  readonly requestTimeoutMs?: number;
  readonly reconnect?: AgentReconnectOptions;
}

function wslEnv(): NodeJS.ProcessEnv {
  return { ...process.env, WSL_UTF8: "1" };
}

export const defaultSpawnWsl: SpawnWslProcess = (distro, argv) =>
  spawn(WSL_EXE, ["-d", distro, "--cd", "~", "-e", ...argv], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: wslEnv(),
  });

export function decodeWslOutput(buffer: Buffer): string {
  const text = buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function createWslBootstrapRunner(
  distro: string,
  spawnImpl: SpawnWslProcess = defaultSpawnWsl,
): SshBootstrapRunner {
  return async (command, args, input, signal) => {
    if (command !== "ssh") {
      throw new Error(`${command} is not used in WSL`);
    }
    const remoteCommand = args[args.length - 1] ?? "";
    signal?.throwIfAborted();
    const child = spawnImpl(distro, ["sh", "-c", remoteCommand]);
    const { stdout, stderr, code } = await collectProcess(child, {
      name: WSL_EXE,
      input,
      signal,
      timeoutMs: WSL_COMMAND_TIMEOUT_MS,
    }).catch((error: unknown) => {
      if (signal?.aborted || (error as { code?: string }).code === "transport.timeout") throw error;
      throw createSshError("transport.unknown", error);
    });
    const err = decodeWslOutput(stderr).trim();
    if (code !== 0) {
      throw createSshError("transport.unknown", new Error(err || `wsl.exe exited ${code}`));
    }
    return { stdout: stdout.toString("utf8"), stderr: err };
  };
}

function bootstrapOptions(options: WslAgentOptions) {
  return {
    host: `wsl:${opaqueTag(options.distro)}`,
    authMode: "key-only" as const,
    remotePath: options.remotePath,
    signal: options.signal,
    cachedRemoteArch: options.cachedRemoteArch,
    workspaceId: options.workspaceId,
  };
}

export async function ensureWslAgent(
  options: WslAgentOptions,
  dependencies: WslBootstrapDependencies = {},
): Promise<EnsureRemoteAgentResult> {
  const result = await ensureRemoteAgent(bootstrapOptions(options), {
    runner: dependencies.runner ?? createWslBootstrapRunner(options.distro),
    onProgress: dependencies.onProgress,
  });
  if (result.platform.os !== "linux") {
    throw createSshError(
      "server.protocol-error",
      new Error(`WSL reported ${result.platform.os}, not linux`),
    );
  }
  return result;
}

export function ensureWslLspServer(
  options: WslLspServerOptions,
  dependencies: WslBootstrapDependencies = {},
): Promise<EnsureRemoteLspServerResult> {
  return ensureRemoteLspServer(
    {
      ...bootstrapOptions(options),
      binaryName: options.binaryName,
      languageId: options.languageId,
    },
    {
      runner: dependencies.runner ?? createWslBootstrapRunner(options.distro),
      onProgress: dependencies.onProgress,
    },
  );
}

export function createWslChannel(
  options: CreateWslChannelOptions,
  dependencies: WslChannelDependencies = {},
): AgentChannel {
  const spawnImpl = dependencies.spawn ?? defaultSpawnWsl;
  return createReconnectingProcessChannel({
    spawn: () => spawnImpl(options.distro, ["sh", "-c", options.remoteCommand]),
    classifyStderr: () => null,
    logLabel: `wsl:${opaqueTag(options.distro)}`,
    closeError: (_wasReady, context) =>
      createSshError("transport.unknown", formatCloseDiagnostic(context)),
    requestTimeoutMs: dependencies.requestTimeoutMs,
    expectedProtocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
    reconnect: dependencies.reconnect,
  });
}

export function parseWslDistros(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name.length > 0 && !name.startsWith("docker-desktop"));
}

export function listWslDistros(
  run: (args: readonly string[]) => Promise<Buffer> = runWslExe,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (platform !== "win32") return Promise.resolve([]);
  return run(["-l", "-q"]).then(
    (stdout) => parseWslDistros(decodeWslOutput(stdout)),
    () => [],
  );
}

export async function runWslExe(args: readonly string[], spawnImpl = spawn): Promise<Buffer> {
  const child = spawnImpl(WSL_EXE, [...args], { windowsHide: true, env: wslEnv() });
  const { stdout, code } = await collectProcess(child, {
    name: WSL_EXE,
    timeoutMs: WSL_LIST_TIMEOUT_MS,
  });
  if (code !== 0) throw new Error(`wsl.exe exited ${code}`);
  return stdout;
}
