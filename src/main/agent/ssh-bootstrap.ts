import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type SpawnOptionsWithoutStdio, spawn as defaultSpawn } from "node:child_process";
import { z } from "zod";
import {
  authenticateSshControlMaster,
  type AuthenticateSshControlMasterDependencies,
  type SshAuthPromptHandler,
} from "./ssh-auth-pty";
import type { SshMasterOptions } from "./ssh-master";
import { createSshError } from "./pipe";

export const REMOTE_AGENT_PROTOCOL_MAJOR = "1";
export const REMOTE_AGENT_VERSION = "0.1.0";
export const REMOTE_AGENT_ROOT = "~/.nexus-code";
export const REMOTE_AGENT_MANIFEST = `${REMOTE_AGENT_ROOT}/manifest.json`;
export const LOCAL_AGENT_DIST_DIR = path.join(process.cwd(), "dist", "agent");

const KEEP_REMOTE_VERSIONS = 3;

const LocalBinarySchema = z.object({
  os: z.enum(["linux", "darwin"]),
  arch: z.enum(["amd64", "arm64"]),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const LocalManifestSchema = z.object({
  version: z.string(),
  protocolVersion: z.string(),
  binaries: z.array(LocalBinarySchema),
});

const RemoteManifestSchema = z.object({
  version: z.string(),
  os: z.string(),
  arch: z.string(),
  sha256: z.string(),
  installedAt: z.string(),
});

export type RemoteAgentPlatform =
  z.infer<typeof LocalBinarySchema> extends infer T
    ? T extends { os: infer Os; arch: infer Arch }
      ? { os: Os; arch: Arch }
      : never
    : never;

export interface EnsureRemoteAgentOptions extends Omit<SshMasterOptions, "remoteCommand"> {
  readonly remotePath: string;
  readonly cachedRemoteArch?: RemoteAgentPlatform;
  readonly authMode?: "interactive" | "key-only";
}

export interface EnsureRemoteAgentResult {
  readonly remoteCommand: string;
  readonly platform: RemoteAgentPlatform;
  readonly uploaded: boolean;
  readonly controlPath?: string;
  readonly dispose?: () => void;
}

export interface SshBootstrapRunnerResult {
  readonly stdout: string;
  readonly stderr?: string;
}

export type SshBootstrapRunner = (
  command: string,
  args: string[],
  input?: Buffer | string,
) => Promise<SshBootstrapRunnerResult>;

export interface SshBootstrapDependencies {
  readonly runner?: SshBootstrapRunner;
  readonly distDir?: string;
  readonly now?: () => Date;
  readonly promptHandler?: SshAuthPromptHandler;
  readonly auth?: AuthenticateSshControlMasterDependencies;
}

export async function ensureRemoteAgent(
  options: EnsureRemoteAgentOptions,
  dependencies: SshBootstrapDependencies = {},
): Promise<EnsureRemoteAgentResult> {
  const runner = dependencies.runner ?? defaultRunner;
  const distDir = dependencies.distDir ?? LOCAL_AGENT_DIST_DIR;
  const now = dependencies.now ?? (() => new Date());
  const authenticatedMaster =
    options.authMode === "interactive" && dependencies.promptHandler
      ? await authenticateSshControlMaster(options, dependencies.promptHandler, dependencies.auth)
      : null;
  const sshOptions = authenticatedMaster
    ? { ...options, controlPath: authenticatedMaster.controlPath }
    : options;

  try {
    const localManifest = LocalManifestSchema.parse(
      JSON.parse(await fs.readFile(path.join(distDir, "manifest.json"), "utf8")),
    );
    const platform = options.cachedRemoteArch ?? (await detectRemotePlatform(sshOptions, runner));
    const binary = localManifest.binaries.find(
      (candidate) => candidate.os === platform.os && candidate.arch === platform.arch,
    );
    if (!binary) {
      throw createSshError(
        "server.protocol-error",
        new Error(`unsupported remote platform ${platform.os}-${platform.arch}`),
      );
    }
    const remoteBinaryPath = remoteAgentBinaryPath(localManifest.version, platform);
    const remoteManifest = await readRemoteManifest(sshOptions, runner);
    const matches =
      remoteManifest?.version === localManifest.version &&
      remoteManifest.os === platform.os &&
      remoteManifest.arch === platform.arch &&
      remoteManifest.sha256 === binary.sha256;

    if (!matches) {
      await uploadAndVerify({
        options: sshOptions,
        runner,
        localPath: path.resolve(distDir, binary.path),
        remoteBinaryPath,
        sha256: binary.sha256,
      });
      await writeRemoteManifest(sshOptions, runner, {
        version: localManifest.version,
        os: platform.os,
        arch: platform.arch,
        sha256: binary.sha256,
        installedAt: now().toISOString(),
      });
      await pruneRemoteVersions(sshOptions, runner, platform);
    }

    return {
      remoteCommand: buildRemoteAgentCommand(remoteBinaryPath, options.remotePath),
      platform,
      uploaded: !matches,
      controlPath: authenticatedMaster?.controlPath,
      dispose: authenticatedMaster ? () => authenticatedMaster.dispose() : undefined,
    };
  } catch (error) {
    authenticatedMaster?.dispose();
    throw error;
  }
}

export function parseUname(value: string): RemoteAgentPlatform {
  const normalized = value.trim().toLowerCase();
  const osName = normalized.includes("darwin")
    ? "darwin"
    : normalized.includes("linux")
      ? "linux"
      : null;
  const arch = /x86_64|amd64/.test(normalized)
    ? "amd64"
    : /aarch64|arm64/.test(normalized)
      ? "arm64"
      : null;
  if (!osName || !arch) {
    throw createSshError("server.protocol-error", new Error(`unsupported uname: ${value.trim()}`));
  }
  return { os: osName, arch };
}

export function remoteAgentBinaryPath(version: string, platform: RemoteAgentPlatform): string {
  return `${REMOTE_AGENT_ROOT}/bin/agent-${version}-${platform.os}-${platform.arch}`;
}

export function buildRemoteAgentCommand(binaryPath: string, remotePath: string): string {
  const script = `exec ${quoteShellArg(binaryPath)} ${quoteShellArg(remotePath)}`;
  return `bash -lc ${singleQuoteShellArg(script)}`;
}

async function detectRemotePlatform(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
): Promise<RemoteAgentPlatform> {
  const result = await runSsh(options, runner, "uname -ms");
  return parseUname(result.stdout);
}

async function readRemoteManifest(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
): Promise<z.infer<typeof RemoteManifestSchema> | null> {
  const result = await runSsh(options, runner, `cat ${REMOTE_AGENT_MANIFEST} 2>/dev/null || true`);
  if (result.stdout.trim().length === 0) return null;
  const parsed = RemoteManifestSchema.safeParse(JSON.parse(result.stdout));
  return parsed.success ? parsed.data : null;
}

async function uploadAndVerify(args: {
  readonly options: EnsureRemoteAgentOptions;
  readonly runner: SshBootstrapRunner;
  readonly localPath: string;
  readonly remoteBinaryPath: string;
  readonly sha256: string;
}): Promise<void> {
  await runSsh(
    args.options,
    args.runner,
    `mkdir -p ${REMOTE_AGENT_ROOT}/bin && chmod 755 ${REMOTE_AGENT_ROOT} ${REMOTE_AGENT_ROOT}/bin`,
  );
  const payload = await fs.readFile(args.localPath);
  if (sha256(payload) !== args.sha256) {
    throw createSshError("server.protocol-error", new Error("local agent sha256 mismatch"));
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await uploadBinary(args.options, args.runner, args.localPath, args.remoteBinaryPath, payload);
    const remoteSha = await remoteSha256(args.options, args.runner, args.remoteBinaryPath);
    if (remoteSha === args.sha256) return;
  }
  throw createSshError("server.protocol-error", new Error("remote agent sha256 mismatch"));
}

async function uploadBinary(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  localPath: string,
  remotePath: string,
  payload: Buffer,
): Promise<void> {
  try {
    await runner(
      "sftp",
      buildSftpArgs(options),
      `put ${localPath} ${sftpRemotePath(remotePath)}\nchmod 755 ${sftpRemotePath(remotePath)}\n`,
    );
  } catch {
    await runSsh(
      options,
      runner,
      `cat > ${quoteShellArg(remotePath)} && chmod 755 ${quoteShellArg(remotePath)}`,
      payload,
    );
  }
}

async function remoteSha256(
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

async function writeRemoteManifest(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  manifest: z.infer<typeof RemoteManifestSchema>,
): Promise<void> {
  await runSsh(options, runner, `cat > ${REMOTE_AGENT_MANIFEST}`, `${JSON.stringify(manifest)}\n`);
}

async function pruneRemoteVersions(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  platform: RemoteAgentPlatform,
): Promise<void> {
  const pattern = `${REMOTE_AGENT_ROOT}/bin/agent-*-${platform.os}-${platform.arch}`;
  await runSsh(
    options,
    runner,
    `ls -1t ${pattern} 2>/dev/null | tail -n +${KEEP_REMOTE_VERSIONS + 1} | xargs -r rm -f`,
  );
}

async function runSsh(
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

function buildSftpArgs(options: EnsureRemoteAgentOptions): string[] {
  const args: string[] = [];
  if (options.port !== undefined) args.push("-P", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  if (options.controlPath) args.push("-o", `ControlPath=${options.controlPath}`);
  args.push(destinationForOptions(options));
  return args;
}

function buildSshTransportArgs(options: EnsureRemoteAgentOptions): string[] {
  const args = ["-o", "BatchMode=yes"];
  if (options.controlPath) args.push("-S", options.controlPath, "-o", "ControlMaster=no");
  if (options.port !== undefined) args.push("-p", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  return args;
}

function destinationForOptions(options: EnsureRemoteAgentOptions): string {
  return options.user ? `${options.user}@${options.host}` : options.host;
}

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~*-]+$/.test(value)) return value;
  return singleQuoteShellArg(value);
}

function sftpRemotePath(value: string): string {
  return value.startsWith("~/") ? value.slice(2) : value;
}

function singleQuoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function defaultRunner(
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
