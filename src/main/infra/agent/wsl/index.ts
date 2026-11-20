/**
 * WSL transport for the agent. A WSL workspace runs the Linux agent inside a
 * distribution the way an SSH workspace runs it on a remote host: the SSH
 * bootstrap installs and verifies the agent there, with each of its remote
 * steps run through `wsl.exe` instead of `ssh`, and the channel spawns the
 * bootstrap's daemon/dialer command line through `wsl.exe` too.
 */

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

/** Starts `argv` in `distro`, in the distribution user's home. */
export type SpawnWslProcess = (
  distro: string,
  argv: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface WslAgentOptions {
  readonly distro: string;
  /** Absolute path inside the distribution; the agent's root. */
  readonly remotePath: string;
  readonly signal?: AbortSignal;
  /** Installs the workspace's shell shim files too, as for SSH. */
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
  /** The bootstrap's `remoteCommand`, a POSIX shell command line. */
  readonly remoteCommand: string;
}

export interface WslChannelDependencies {
  readonly spawn?: SpawnWslProcess;
  readonly requestTimeoutMs?: number;
  readonly reconnect?: AgentReconnectOptions;
}

/**
 * wsl.exe writes its own messages (an unknown distribution, no WSL) in
 * UTF-16 unless WSL_UTF8 is set. The variable stays on the Windows side.
 */
function wslEnv(): NodeJS.ProcessEnv {
  return { ...process.env, WSL_UTF8: "1" };
}

export const defaultSpawnWsl: SpawnWslProcess = (distro, argv) =>
  spawn(WSL_EXE, ["-d", distro, "--cd", "~", "-e", ...argv], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: wslEnv(),
  });

/**
 * Text from wsl.exe: UTF-8 with WSL_UTF8 set, UTF-16LE from a wsl.exe too
 * old to know the variable.
 */
export function decodeWslOutput(buffer: Buffer): string {
  const text = buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Runs the SSH bootstrap's remote steps in `distro`. The bootstrap hands
 * each step over as `ssh <options> -- <destination> <command>`; the command
 * runs under `sh -c` in the distribution. It also tries `sftp` for uploads,
 * which has no counterpart here: the refusal sends it to its fallback, the
 * file piped into `cat`.
 */
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
    // Keys the bootstrap's per-host upload lock and nothing else.
    host: `wsl:${opaqueTag(options.distro)}`,
    authMode: "key-only" as const,
    remotePath: options.remotePath,
    signal: options.signal,
    cachedRemoteArch: options.cachedRemoteArch,
    workspaceId: options.workspaceId,
  };
}

/**
 * Installs the agent (and the Claude wrapper and shell shim files) in the
 * distribution when missing or stale, and returns the command line that
 * starts it there.
 */
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

/** Installs a language server in the distribution, as for an SSH host. */
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

/**
 * Opens the NDJSON channel to the agent in the distribution. The command
 * line keeps a daemon running there, so a dropped `wsl.exe` reconnects to
 * the same terminals.
 */
export function createWslChannel(
  options: CreateWslChannelOptions,
  dependencies: WslChannelDependencies = {},
): AgentChannel {
  const spawnImpl = dependencies.spawn ?? defaultSpawnWsl;
  return createReconnectingProcessChannel({
    spawn: () => spawnImpl(options.distro, ["sh", "-c", options.remoteCommand]),
    // wsl.exe asks nothing, so stderr carries no prompt to recognize.
    classifyStderr: () => null,
    logLabel: `wsl:${opaqueTag(options.distro)}`,
    closeError: (_wasReady, context) =>
      createSshError("transport.unknown", formatCloseDiagnostic(context)),
    requestTimeoutMs: dependencies.requestTimeoutMs,
    expectedProtocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
    reconnect: dependencies.reconnect,
  });
}

/**
 * Parses `wsl.exe -l -q`. Docker Desktop's distributions hold its engine,
 * not a place to work, and are left out.
 */
export function parseWslDistros(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name.length > 0 && !name.startsWith("docker-desktop"));
}

/**
 * The installed WSL distributions; none off Windows, without WSL, or when
 * wsl.exe fails (it exits non-zero when no distribution is installed).
 */
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

/** Runs WSL discovery with the same child ownership as bootstrap commands. */
export async function runWslExe(args: readonly string[], spawnImpl = spawn): Promise<Buffer> {
  const child = spawnImpl(WSL_EXE, [...args], { windowsHide: true, env: wslEnv() });
  const { stdout, code } = await collectProcess(child, {
    name: WSL_EXE,
    timeoutMs: WSL_LIST_TIMEOUT_MS,
  });
  if (code !== 0) throw new Error(`wsl.exe exited ${code}`);
  return stdout;
}
