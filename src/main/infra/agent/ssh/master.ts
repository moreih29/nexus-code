import {
  type ChildProcessWithoutNullStreams,
  spawn as defaultSpawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SshMasterOptions {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly remoteCommand: string;
  readonly controlPath?: string;
}

export type SpawnSshProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface SshMasterDependencies {
  readonly spawn?: SpawnSshProcess;
  readonly unlink?: (path: string) => void;
}

export interface SshControlMaster {
  readonly controlPath: string;
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  dispose(): void;
}

const CONTROL_EXIT_UNLINK_FALLBACK_MS = 5_000;

/**
 * Keepalive options applied to every long-lived ssh invocation (the agent
 * channel and the persistent ControlMaster). Without these, a client that dies
 * abnormally (force-kill, sleep, network drop) leaves the remote agent — and
 * the binary it holds — alive until the kernel's default TCP timeout (hours),
 * which then blocks the next launch's re-upload. ServerAliveInterval probes the
 * peer at the SSH layer; after ServerAliveCountMax unanswered probes ssh exits,
 * the remote session tears down, and the agent gets stdin EOF. ~15s × 3 ≈ 45s.
 */
const SSH_KEEPALIVE_ARGS: readonly string[] = [
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

/**
 * Spawns the SSH client for direct stdin/stdout NDJSON exchange. Interactive
 * ControlMaster authentication and socket reuse live in `ssh-master`'s
 * controlMaster helpers and in `ssh-auth-pty`; this function builds the
 * batch-mode client over the resulting socket.
 */
export function spawnSshMaster(
  options: SshMasterOptions,
  dependencies: SshMasterDependencies = {},
): ChildProcessWithoutNullStreams {
  const spawnFn = dependencies.spawn ?? defaultSpawnSsh;
  return spawnFn("ssh", buildSshArgs(options), {
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Creates the OpenSSH argument list without invoking a shell locally.
 */
export function buildSshArgs(options: SshMasterOptions): string[] {
  const args = ["-o", "BatchMode=yes", ...SSH_KEEPALIVE_ARGS];
  if (options.controlPath) {
    args.push("-S", options.controlPath, "-o", "ControlMaster=no");
  }
  if (options.port !== undefined) {
    args.push("-p", String(options.port));
  }
  if (options.identityFile) {
    args.push("-i", options.identityFile);
  }
  args.push("--", destinationForOptions(options), options.remoteCommand);
  return args;
}

/**
 * Creates a process-owned ControlMaster descriptor that can later send
 * `ssh -O exit` and remove the socket path exactly once.
 */
export function createSshControlMaster(
  options: Omit<SshMasterOptions, "remoteCommand"> & { readonly controlPath?: string },
  dependencies: SshMasterDependencies = {},
): SshControlMaster {
  // ownsTempDir: controlPath 를 우리가 createControlPath() 로 만들었으면 그
  // 부모 nexus-ssh-XXXX/ 임시 디렉토리도 우리 소유 — dispose 때 디렉토리째
  // 제거한다. 호출자가 controlPath 를 넘긴 경우엔 소켓 파일만 지운다.
  const ownsTempDir = options.controlPath === undefined;
  const controlPath = options.controlPath ?? createControlPath();
  let disposed = false;
  return {
    controlPath,
    host: options.host,
    user: options.user,
    port: options.port,
    identityFile: options.identityFile,
    dispose() {
      if (disposed) return;
      disposed = true;
      const spawnFn = dependencies.spawn ?? defaultSpawnSsh;
      try {
        const child = spawnFn("ssh", buildSshControlExitArgs({ ...options, controlPath }), {
          detached: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        unlinkAfterControlExit(child, controlPath, ownsTempDir, dependencies.unlink);
        child.stdin.end();
        return;
      } catch {
        // Cleanup below is still attempted if OpenSSH is unavailable or fails.
      }
      tryUnlink(controlPath, ownsTempDir, dependencies.unlink);
    },
  };
}

/**
 * Removes the ControlMaster socket after OpenSSH has processed `-O exit`.
 * Immediate unlink can race the master shutdown and leave a ControlPersist
 * process alive until its timeout, so the normal path waits for close/exit and
 * the fallback handles a stuck exit helper.
 */
function unlinkAfterControlExit(
  child: ChildProcessWithoutNullStreams,
  controlPath: string,
  ownsTempDir: boolean,
  unlink?: (path: string) => void,
): void {
  let cleaned = false;
  const timer = setTimeout(cleanup, CONTROL_EXIT_UNLINK_FALLBACK_MS);
  timer.unref?.();
  child.once("close", cleanup);
  child.once("exit", cleanup);
  child.once("error", cleanup);

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    child.off("close", cleanup);
    child.off("exit", cleanup);
    child.off("error", cleanup);
    tryUnlink(controlPath, ownsTempDir, unlink);
  }
}

/** Builds the interactive auth command that backgrounds a persistent master. */
export function buildSshControlMasterArgs(
  options: Omit<SshMasterOptions, "remoteCommand"> & { readonly controlPath: string },
): string[] {
  const args = [
    "-M",
    "-S",
    options.controlPath,
    "-o",
    "ControlMaster=yes",
    "-o",
    "ControlPersist=60",
    ...SSH_KEEPALIVE_ARGS,
    "-f",
    "-N",
  ];
  if (options.port !== undefined) args.push("-p", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  args.push("--", destinationForOptions(options));
  return args;
}

/** Builds the dispose command for an existing ControlMaster socket. */
export function buildSshControlExitArgs(
  options: Omit<SshMasterOptions, "remoteCommand"> & { readonly controlPath: string },
): string[] {
  const args = ["-S", options.controlPath, "-O", "exit"];
  if (options.port !== undefined) args.push("-p", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  args.push("--", destinationForOptions(options));
  return args;
}

/**
 * Renders the OpenSSH destination from an optional user and host.
 */
function destinationForOptions(options: Omit<SshMasterOptions, "remoteCommand">): string {
  return options.user ? `${options.user}@${options.host}` : options.host;
}

function createControlPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ssh-"));
  return path.join(dir, "control.sock");
}

function tryUnlink(
  controlPath: string,
  ownsTempDir: boolean,
  unlink?: (path: string) => void,
): void {
  try {
    if (unlink) {
      unlink(controlPath);
      return;
    }
    if (ownsTempDir) {
      // createControlPath() 가 이 소켓 하나를 담으려고 만든 일회용
      // nexus-ssh-XXXX/ 디렉토리 — 소켓만 unlink 하면 빈 디렉토리가
      // os.tmpdir() 에 연결마다 하나씩 누적되므로 디렉토리째 제거한다.
      fs.rmSync(path.dirname(controlPath), { recursive: true, force: true });
      return;
    }
    fs.unlinkSync(controlPath);
  } catch {
    // The socket may already be gone after a failed or clean master exit.
  }
}

/**
 * Production spawn adapter. Tests can inject a fake child through dependencies.
 */
function defaultSpawnSsh(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return defaultSpawn(command, args, options) as ChildProcessWithoutNullStreams;
}
