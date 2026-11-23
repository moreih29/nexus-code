import {
  type ChildProcessWithoutNullStreams,
  spawn as defaultSpawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSsh2Process, usesSsh2Client } from "./ssh2";

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

const SSH_KEEPALIVE_ARGS: readonly string[] = [
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=3",
];

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
  args.push("--", sshDestination(options), options.remoteCommand);
  return args;
}

export function createSshControlMaster(
  options: Omit<SshMasterOptions, "remoteCommand"> & { readonly controlPath?: string },
  dependencies: SshMasterDependencies = {},
): SshControlMaster {
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
      } catch {}
      tryUnlink(controlPath, ownsTempDir, dependencies.unlink);
    },
  };
}

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
  args.push("--", sshDestination(options));
  return args;
}

export function buildSshControlExitArgs(
  options: Omit<SshMasterOptions, "remoteCommand"> & { readonly controlPath: string },
): string[] {
  const args = ["-S", options.controlPath, "-O", "exit"];
  if (options.port !== undefined) args.push("-p", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  args.push("--", sshDestination(options));
  return args;
}

export function sshDestination(options: Pick<SshMasterOptions, "host" | "user">): string {
  return options.user ? `${options.user}@${options.host}` : options.host;
}

function createControlPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ssh-"));
  return path.join(dir, "control.sock");
}

const SWEEP_PROBE_TIMEOUT_MS = 1_000;

export async function sweepStaleControlDirs(tmpRoot: string = os.tmpdir()): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("nexus-ssh-"))
      .map((entry) => sweepOneControlDir(path.join(tmpRoot, entry.name))),
  );
}

async function sweepOneControlDir(dir: string): Promise<void> {
  try {
    const contents = await fs.promises.readdir(dir);
    if (contents.length === 0) {
      await fs.promises.rmdir(dir);
      return;
    }
    if (contents.length === 1 && contents[0] === "control.sock") {
      const live = await probeUnixSocket(path.join(dir, "control.sock"));
      if (!live) {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    }
  } catch {}
}

function probeUnixSocket(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(SWEEP_PROBE_TIMEOUT_MS, () => done(true));
  });
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
      fs.rmSync(path.dirname(controlPath), { recursive: true, force: true });
      return;
    }
    fs.unlinkSync(controlPath);
  } catch {}
}

export function defaultSpawnSsh(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  if (usesSsh2Client()) return spawnSsh2Process(command, args);
  return defaultSpawn(command, args, options) as ChildProcessWithoutNullStreams;
}
