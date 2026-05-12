import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn as defaultSpawn,
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

/**
 * Spawns the SSH client for direct stdin/stdout NDJSON exchange. Today this is
 * a single-connection invocation; once Phase 1 (PTY-based interactive auth)
 * lands, this module is where ControlMaster (`-M -S /tmp/...sock`) will be
 * added so Phase 2 traffic can reuse the authenticated socket.
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
  const args = ["-o", "BatchMode=yes"];
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
        child.stdin.end();
      } catch {
        // Cleanup below is still attempted if OpenSSH is unavailable or fails.
      }
      tryUnlink(controlPath, dependencies.unlink);
    },
  };
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

function tryUnlink(controlPath: string, unlink?: (path: string) => void): void {
  try {
    if (unlink) unlink(controlPath);
    else fs.unlinkSync(controlPath);
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
