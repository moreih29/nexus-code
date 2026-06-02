/**
 * SSH/SFTP transport helpers used by the bootstrap orchestrator. These keep
 * one place responsible for shelling out to `ssh`/`sftp`, framing commands,
 * uploading and verifying files, and quoting arbitrary strings into safe
 * shell or sftp tokens.
 */

import { spawn as defaultSpawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
  // Keepalive so a bootstrap command over a dead connection fails fast (~45s)
  // rather than hanging on the kernel's default TCP timeout.
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
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Upload to a unique temp path in the same directory, then atomically
    // rename it into place. `mv -f` over a file that a lingering OLD agent is
    // still executing succeeds — the running process keeps the old inode while
    // the name is repointed to the new one — so a stale remote agent never
    // blocks reinstall with ETXTBSY ("Text file busy"). Same-dir rename keeps
    // it on one filesystem, so the swap is atomic with no missing-file window.
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
      // `sftp` exits 0 even when an individual `put` fails (a failed transfer
      // is reported on stderr but never sets a nonzero exit code), so a
      // transient upload error is invisible to uploadFile() — the temp file
      // may be missing or truncated. The `mv` below would then throw
      // ("no such file"), aborting the whole bootstrap. We therefore treat the
      // entire upload→rename→verify sequence as one fallible attempt: any
      // failure (missing temp, rename error, or sha mismatch) retries the full
      // upload instead of propagating, restoring the pre-atomic-install
      // resilience where the sha check alone gated correctness.
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
    // Best-effort: drop a temp file orphaned by a failed attempt so retries
    // (and future bootstraps) never accumulate `.tmp.<rand>` litter alongside
    // the installed binary.
    await runSsh(args.options, args.runner, `rm -f ${quoteShellArg(tmpRemotePath)}`).catch(
      () => undefined,
    );
  }
  throw (
    lastError ??
    createSshError("server.protocol-error", new Error("remote artifact sha256 mismatch"))
  );
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

/**
 * sftp 명령 파서는 공백을 인자 구분자로 처리하므로, 공백·특수문자가 들어 있는
 * 경로는 반드시 따옴표로 감싸야 한다 (shell quoting과는 별개의 sftp 자체
 * 파서). 공백 경로가 unquoted로 sftp `put`에 전달되면 첫 토큰만 인자로
 * 인식되어 엉뚱한 파일이 업로드되거나 sha256 검증이 실패한다 — `productName`이
 * `Nexus Code`이던 시절 `/Applications/Nexus Code.app/...` 경로에서 발현됐던
 * 회귀를 안전망으로 잡는다.
 *
 * OpenSSH sftp는 double-quote(`"`)로 감싼 인자를 단일 token으로 처리한다.
 * 경로 안의 `"` 문자는 안전하게 escape할 표준이 없으므로 거부한다 — 실무에서
 * 일반적인 macOS/Linux 경로에 `"`가 들어가는 일은 거의 없다.
 */
export function sftpQuotePath(value: string): string {
  if (value.includes('"')) {
    throw new Error(
      `sftp path contains an embedded double-quote, refusing to quote safely: ${value}`,
    );
  }
  return `"${value}"`;
}

/**
 * Strips `~/` (sftp interprets it as a literal filename) then sftp-quotes the
 * result so that paths containing spaces — e.g. `/Applications/Nexus Code.app`
 * inside a packaged build — survive the sftp tokenizer intact.
 */
export function sftpRemotePath(value: string): string {
  const stripped = value.startsWith("~/") ? value.slice(2) : value;
  return sftpQuotePath(stripped);
}

/** Always single-quotes the value, escaping embedded quotes safely. */
export function singleQuoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
