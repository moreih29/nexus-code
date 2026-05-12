import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn as defaultSpawn,
} from "node:child_process";

export interface SshMasterOptions {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly remoteCommand: string;
}

export type SpawnSshProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface SshMasterDependencies {
  readonly spawn?: SpawnSshProcess;
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
 * Renders the OpenSSH destination from an optional user and host.
 */
function destinationForOptions(options: SshMasterOptions): string {
  return options.user ? `${options.user}@${options.host}` : options.host;
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
