import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectProcess } from "../../collect-process";
import { createSshError } from "../../pipe";
import { defaultSpawnSsh, sshDestination } from "../master";
import {
  type EnsureRemoteAgentOptions,
  type LspBootstrapProgressEvent,
  REMOTE_AGENT_BOOTSTRAP_TIMEOUT_MS,
  type SshBootstrapRunner,
  type SshBootstrapRunnerResult,
} from "./types";

export async function defaultRunner(
  command: string,
  args: string[],
  input?: Buffer | string,
  signal?: AbortSignal,
): Promise<SshBootstrapRunnerResult> {
  signal?.throwIfAborted();
  const child = defaultSpawnSsh(command, args, {
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { stdout, stderr, code } = await collectProcess(child, {
    name: command,
    input,
    signal,
    timeoutMs: REMOTE_AGENT_BOOTSTRAP_TIMEOUT_MS,
  });
  const err = stderr.toString("utf8").trim();
  if (code !== 0)
    throw createSshError("ssh.unknown", new Error(err || `${command} exited ${code}`));
  return { stdout: stdout.toString("utf8"), stderr: err };
}

export async function runSsh(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  remoteCommand: string,
  input?: Buffer | string,
): Promise<SshBootstrapRunnerResult> {
  return runner(
    "ssh",
    [...buildSshTransportArgs(options), "--", sshDestination(options), remoteCommand],
    input,
  );
}

export function buildSftpArgs(options: EnsureRemoteAgentOptions): string[] {
  const args: string[] = [];
  if (options.port !== undefined) args.push("-P", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  if (options.controlPath) args.push("-o", `ControlPath=${options.controlPath}`);
  args.push(sshDestination(options));
  return args;
}

export function buildSshTransportArgs(options: EnsureRemoteAgentOptions): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (options.controlPath) args.push("-S", options.controlPath, "-o", "ControlMaster=no");
  if (options.port !== undefined) args.push("-p", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  return args;
}

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
  await runSsh(
    args.options,
    args.runner,
    `find ${quoteShellArg(remoteDir)} -maxdepth 1 -name ${singleQuoteShellArg(`${path.posix.basename(args.remotePath)}.tmp.*`)} -mmin +5 -delete`,
  ).catch(() => undefined);
  const payload = await fs.readFile(args.localPath);
  if (sha256(payload) !== args.sha256) {
    throw createSshError("server.protocol-error", new Error("local artifact sha256 mismatch"));
  }

  const progressName = args.progressName ?? path.basename(args.remotePath);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tmpRemotePath = `${args.remotePath}.tmp.${randomBytes(6).toString("hex")}`;
    try {
      args.onProgress?.({
        name: progressName,
        phase: "uploading",
        bytesDone: 0,
        bytesTotal: payload.byteLength,
      });
      await uploadFile(args.options, args.runner, args.localPath, tmpRemotePath, payload, {
        executable: args.executable,
      });
      await runSsh(
        args.options,
        args.runner,
        `mv -f ${quoteShellArg(tmpRemotePath)} ${quoteShellArg(args.remotePath)}`,
      );
      args.onProgress?.({
        name: progressName,
        phase: "uploading",
        bytesDone: payload.byteLength,
        bytesTotal: payload.byteLength,
      });
      args.onProgress?.({ name: progressName, phase: "verifying" });
      const remoteSha = await remoteSha256(args.options, args.runner, args.remotePath);
      if (remoteSha === args.sha256) return;
      lastError = createSshError(
        "server.protocol-error",
        new Error("remote artifact sha256 mismatch"),
      );
    } catch (error) {
      lastError = error;
    }
    await runSsh(args.options, args.runner, `rm -f ${quoteShellArg(tmpRemotePath)}`).catch(
      () => undefined,
    );
  }
  throw (
    lastError ??
    createSshError("server.protocol-error", new Error("remote artifact sha256 mismatch"))
  );
}

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
      `put ${sftpQuotePath(localPath)} ${sftpRemotePath(remotePath)}\n${chmod}`,
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

export function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~*-]+$/.test(value)) return value;
  return singleQuoteShellArg(value);
}

export function sftpQuotePath(value: string): string {
  if (value.includes('"')) {
    throw new Error(
      `sftp path contains an embedded double-quote, refusing to quote safely: ${value}`,
    );
  }
  return `"${value}"`;
}

export function sftpRemotePath(value: string): string {
  const stripped = value.startsWith("~/") ? value.slice(2) : value;
  return sftpQuotePath(stripped);
}

export function singleQuoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
