/**
 * SSH/SFTP transport helpers used by the bootstrap orchestrator. These keep
 * one place responsible for shelling out to `ssh`/`sftp`, framing commands,
 * uploading and verifying files, and quoting arbitrary strings into safe
 * shell or sftp tokens.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type SpawnOptionsWithoutStdio, spawn as defaultSpawn } from "node:child_process";
import { createSshError } from "../../pipe";
import type {
  EnsureRemoteAgentOptions,
  LspBootstrapProgressEvent,
  SshBootstrapRunner,
  SshBootstrapRunnerResult,
} from "./types";

/**
 * Spawns one transport command and collects its stdout/stderr. The bootstrap
 * orchestrator uses this only as a fallback when the caller does not inject
 * a runner; tests inject a mock runner instead.
 */
export async function defaultRunner(
  command: string,
  args: string[],
  input?: Buffer | string,
): Promise<SshBootstrapRunnerResult> {
  return new Promise((resolve, reject) => {
    const child = defaultSpawn(command, args, {
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    } satisfies SpawnOptionsWithoutStdio);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(createSshError("ssh.unknown", new Error(err || `${command} exited ${code}`)));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Runs one remote command through ssh with the standard transport args. */
export async function runSsh(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  remoteCommand: string,
  input?: Buffer | string,
): Promise<SshBootstrapRunnerResult> {
  return runner(
    "ssh",
    [...buildSshTransportArgs(options), "--", destinationForOptions(options), remoteCommand],
    input,
  );
}

/** Builds the sftp command line for batch-mode interactive uploads. */
export function buildSftpArgs(options: EnsureRemoteAgentOptions): string[] {
  const args: string[] = [];
  if (options.port !== undefined) args.push("-P", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  if (options.controlPath) args.push("-o", `ControlPath=${options.controlPath}`);
  args.push(destinationForOptions(options));
  return args;
}

/** Builds the ssh transport args shared by every remote command we run. */
export function buildSshTransportArgs(options: EnsureRemoteAgentOptions): string[] {
  const args = ["-o", "BatchMode=yes"];
  if (options.controlPath) args.push("-S", options.controlPath, "-o", "ControlMaster=no");
  if (options.port !== undefined) args.push("-p", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  return args;
}

/** Composes `user@host` if a user was supplied, otherwise just the host. */
export function destinationForOptions(options: EnsureRemoteAgentOptions): string {
  return options.user ? `${options.user}@${options.host}` : options.host;
}

/** Uploads a local file to a remote path, retries once, and verifies sha256. */
export async function uploadAndVerifyFile(args: {
  readonly options: EnsureRemoteAgentOptions;
  readonly runner: SshBootstrapRunner;
  readonly localPath: string;
  readonly remotePath: string;
  readonly sha256: string;
  readonly executable: boolean;
  readonly progressName?: string;
  readonly onProgress?: (event: LspBootstrapProgressEvent) => void;
  readonly remoteAgentRoot: string;
}): Promise<void> {
  const remoteDir = path.posix.dirname(args.remotePath);
  await runSsh(
    args.options,
    args.runner,
    `mkdir -p ${quoteShellArg(remoteDir)} && chmod 755 ${args.remoteAgentRoot} ${quoteShellArg(remoteDir)}`,
  );
  const payload = await fs.readFile(args.localPath);
  if (sha256(payload) !== args.sha256) {
    throw createSshError("server.protocol-error", new Error("local artifact sha256 mismatch"));
  }

  const progressName = args.progressName ?? path.basename(args.remotePath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    args.onProgress?.({
      name: progressName,
      phase: "uploading",
      bytesDone: 0,
      bytesTotal: payload.byteLength,
    });
    await uploadFile(args.options, args.runner, args.localPath, args.remotePath, payload, {
      executable: args.executable,
    });
    args.onProgress?.({
      name: progressName,
      phase: "uploading",
      bytesDone: payload.byteLength,
      bytesTotal: payload.byteLength,
    });
    args.onProgress?.({ name: progressName, phase: "verifying" });
    const remoteSha = await remoteSha256(args.options, args.runner, args.remotePath);
    if (remoteSha === args.sha256) return;
  }
  throw createSshError("server.protocol-error", new Error("remote artifact sha256 mismatch"));
}

/** sftp put with cat-pipe fallback when sftp is unavailable on the remote. */
async function uploadFile(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  localPath: string,
  remotePath: string,
  payload: Buffer,
  opts: { readonly executable: boolean },
): Promise<void> {
  const chmod = opts.executable ? `chmod 755 ${sftpRemotePath(remotePath)}\n` : "";
  try {
    await runner(
      "sftp",
      buildSftpArgs(options),
      `put ${localPath} ${sftpRemotePath(remotePath)}\n${chmod}`,
    );
  } catch {
    const mode = opts.executable ? "755" : "644";
    await runSsh(
      options,
      runner,
      `cat > ${quoteShellArg(remotePath)} && chmod ${mode} ${quoteShellArg(remotePath)}`,
      payload,
    );
  }
}

/** Computes the remote file's sha256 using whichever tool is available. */
export async function remoteSha256(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  remotePath: string,
): Promise<string> {
  const result = await runSsh(
    options,
    runner,
    `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${quoteShellArg(remotePath)} | cut -d' ' -f1; else shasum -a 256 ${quoteShellArg(remotePath)} | cut -d' ' -f1; fi`,
  );
  return result.stdout.trim();
}

/** Computes a sha256 hex digest for a local buffer. */
export function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Single-quotes a shell argument when it contains unsafe characters; passes
 * obviously safe alphanumeric/path-only values through unchanged.
 */
export function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~*-]+$/.test(value)) return value;
  return singleQuoteShellArg(value);
}

/** Strips `~/` from a path because sftp interprets it literally as a file. */
export function sftpRemotePath(value: string): string {
  return value.startsWith("~/") ? value.slice(2) : value;
}

/** Always single-quotes the value, escaping embedded quotes safely. */
export function singleQuoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
