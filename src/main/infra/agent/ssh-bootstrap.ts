import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type SpawnOptionsWithoutStdio, spawn as defaultSpawn } from "node:child_process";
import { z } from "zod";
import {
  AgentArtifactPlatformSchema,
  AgentManifestSchema,
  findAgentBinary,
  findLspBinary,
  findNodeRuntime,
  type AgentArtifactPlatform,
  type LspBinaryManifestEntry,
  type NodeRuntimeManifestEntry,
} from "../../../shared/agent-manifest";
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
export const LSP_BOOTSTRAP_PROGRESS_EVENT = "lsp.bootstrap.progress";

const KEEP_REMOTE_VERSIONS = 3;

const RemoteArtifactRecordSchema = z.object({
  kind: z.enum(["agent", "node", "lsp"]),
  name: z.string(),
  version: z.string(),
  os: AgentArtifactPlatformSchema.shape.os.optional(),
  arch: AgentArtifactPlatformSchema.shape.arch.optional(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().optional(),
  installedAt: z.string(),
});

const RemoteArtifactManifestSchema = z.object({
  version: z.string().optional(),
  protocolVersion: z.string().optional(),
  artifacts: z.record(RemoteArtifactRecordSchema),
});

const LegacyRemoteManifestSchema = z.object({
  version: z.string(),
  os: AgentArtifactPlatformSchema.shape.os,
  arch: AgentArtifactPlatformSchema.shape.arch,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.string(),
});

type RemoteArtifactManifest = z.infer<typeof RemoteArtifactManifestSchema>;
type RemoteArtifactRecord = z.infer<typeof RemoteArtifactRecordSchema>;

export type RemoteAgentPlatform = AgentArtifactPlatform;

export type LspBootstrapProgressPhase =
  | "checking"
  | "skipped"
  | "uploading"
  | "verifying"
  | "extracting"
  | "linking"
  | "pruning"
  | "ready";

export interface LspBootstrapProgressEvent {
  readonly name: string;
  readonly phase: LspBootstrapProgressPhase;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
}

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

export interface EnsureRemoteLspServerOptions extends EnsureRemoteAgentOptions {
  readonly binaryName: string;
  readonly languageId?: string;
}

export interface EnsureRemoteLspServerResult {
  readonly binaryPath: string;
  readonly args: readonly string[];
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
  readonly onProgress?: (event: LspBootstrapProgressEvent) => void;
}

interface ArtifactInstallRequest {
  readonly key: string;
  readonly record: Omit<RemoteArtifactRecord, "installedAt">;
  readonly install: () => Promise<void>;
  readonly prune: () => Promise<void>;
  readonly progressName: string;
}

interface ArtifactEnsureResult {
  readonly uploaded: boolean;
}

const artifactLocks = new Map<string, Promise<ArtifactEnsureResult>>();

export async function ensureRemoteAgent(
  options: EnsureRemoteAgentOptions,
  dependencies: SshBootstrapDependencies = {},
): Promise<EnsureRemoteAgentResult> {
  const context = await createBootstrapContext(options, dependencies);
  const { runner, distDir, now, sshOptions, authenticatedMaster } = context;

  try {
    const localManifest = AgentManifestSchema.parse(
      JSON.parse(await fs.readFile(path.join(distDir, "manifest.json"), "utf8")),
    );
    const platform = options.cachedRemoteArch ?? (await detectRemotePlatform(sshOptions, runner));
    const binary = findAgentBinary(localManifest, platform);
    if (!binary) {
      throw createSshError(
        "server.protocol-error",
        new Error(`unsupported remote platform ${platform.os}-${platform.arch}`),
      );
    }

    const remoteBinaryPath = remoteAgentBinaryPath(localManifest.version, platform);
    const ensured = await ensureRemoteArtifact(
      sshOptions,
      runner,
      now,
      {
        key: agentArtifactKey(platform),
        record: {
          kind: "agent",
          name: "agent",
          version: localManifest.version,
          os: platform.os,
          arch: platform.arch,
          path: remoteBinaryPath,
          sha256: binary.sha256,
          size: binary.size,
        },
        progressName: `agent-${platform.os}-${platform.arch}`,
        install: () =>
          uploadAndVerifyFile({
            options: sshOptions,
            runner,
            localPath: path.resolve(distDir, binary.path),
            remotePath: remoteBinaryPath,
            sha256: binary.sha256,
            executable: true,
          }),
        prune: () =>
          pruneRemoteVersions(
            sshOptions,
            runner,
            `${REMOTE_AGENT_ROOT}/bin/agent-*-${platform.os}-${platform.arch}`,
          ),
      },
      dependencies.onProgress,
    );

    // On success, ownership of the ControlMaster passes to the caller via the
    // returned `dispose` callback. The caller is responsible for calling it.
    return {
      remoteCommand: buildRemoteAgentCommand(remoteBinaryPath, options.remotePath),
      platform,
      uploaded: ensured.uploaded,
      controlPath: authenticatedMaster?.controlPath,
      dispose: authenticatedMaster ? () => authenticatedMaster.dispose() : undefined,
    };
  } catch (error) {
    // This function never returned, so the caller has no dispose handle.
    // Dispose the ControlMaster here before propagating the error.
    authenticatedMaster?.dispose();
    throw error;
  }
}

export async function ensureRemoteLspServer(
  options: EnsureRemoteLspServerOptions,
  dependencies: SshBootstrapDependencies = {},
): Promise<EnsureRemoteLspServerResult> {
  const context = await createBootstrapContext(options, dependencies);
  const { runner, distDir, now, sshOptions, authenticatedMaster } = context;

  try {
    const localManifest = AgentManifestSchema.parse(
      JSON.parse(await fs.readFile(path.join(distDir, "manifest.json"), "utf8")),
    );
    const platform = options.cachedRemoteArch ?? (await detectRemotePlatform(sshOptions, runner));
    const node = findNodeRuntime(localManifest, platform);
    if (!node) {
      throw createSshError(
        "server.protocol-error",
        new Error(`missing Node runtime for ${platform.os}-${platform.arch}`),
      );
    }
    const lsp = findLspBinary(localManifest, {
      name: options.binaryName,
      languageId: options.languageId,
    });
    if (!lsp) {
      throw createSshError(
        "server.protocol-error",
        new Error(`missing LSP binary for ${options.binaryName}`),
      );
    }

    const remoteHome = await detectRemoteHome(sshOptions, runner);
    const nodeDir = remoteNodeRuntimeDir(node, platform);
    const nodePath = absoluteRemotePath(remoteHome, `${nodeDir}/${node.entry}`);
    const lspDir = remoteLspBinaryDir(lsp);
    const lspLauncherPath = `${lspDir}/${lsp.launcher}`;
    const lspEntryPath = absoluteRemotePath(remoteHome, `${lspDir}/${lsp.entry}`);

    const nodeEnsure = await ensureRemoteNodeRuntime(
      sshOptions,
      runner,
      distDir,
      now,
      node,
      platform,
      dependencies.onProgress,
    );
    const lspEnsure = await ensureRemoteLspArchive(
      sshOptions,
      runner,
      distDir,
      now,
      lsp,
      dependencies.onProgress,
    );

    emitProgress(dependencies.onProgress, { name: lsp.name, phase: "linking" });
    await writeRemoteLspLauncher(sshOptions, runner, {
      launcherPath: lspLauncherPath,
      nodePath,
      entryPath: lspEntryPath,
    });
    emitProgress(dependencies.onProgress, { name: lsp.name, phase: "ready" });

    return {
      binaryPath: absoluteRemotePath(remoteHome, lspLauncherPath),
      args: lsp.argsTemplate,
      platform,
      uploaded: nodeEnsure.uploaded || lspEnsure.uploaded,
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

async function createBootstrapContext(
  options: EnsureRemoteAgentOptions,
  dependencies: SshBootstrapDependencies,
): Promise<{
  readonly runner: SshBootstrapRunner;
  readonly distDir: string;
  readonly now: () => Date;
  readonly sshOptions: EnsureRemoteAgentOptions;
  readonly authenticatedMaster: Awaited<ReturnType<typeof authenticateSshControlMaster>> | null;
}> {
  const runner = dependencies.runner ?? defaultRunner;
  const distDir = dependencies.distDir ?? LOCAL_AGENT_DIST_DIR;
  const now = dependencies.now ?? (() => new Date());
  const shouldAuthenticate =
    options.authMode === "interactive" && dependencies.promptHandler && !options.controlPath;
  const authenticatedMaster = shouldAuthenticate
    ? await authenticateSshControlMaster(options, dependencies.promptHandler, dependencies.auth)
    : null;
  const sshOptions = authenticatedMaster
    ? { ...options, controlPath: authenticatedMaster.controlPath }
    : options;
  return { runner, distDir, now, sshOptions, authenticatedMaster };
}

async function detectRemotePlatform(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
): Promise<RemoteAgentPlatform> {
  const result = await runSsh(options, runner, "uname -ms");
  return parseUname(result.stdout);
}

async function detectRemoteHome(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
): Promise<string> {
  const result = await runSsh(options, runner, `printf '%s\n' "$HOME"`);
  const home = result.stdout.trim();
  if (!home.startsWith("/")) {
    throw createSshError("server.protocol-error", new Error(`invalid remote HOME: ${home}`));
  }
  return home;
}

async function readRemoteManifest(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
): Promise<RemoteArtifactManifest> {
  const result = await runSsh(options, runner, `cat ${REMOTE_AGENT_MANIFEST} 2>/dev/null || true`);
  if (result.stdout.trim().length === 0) return { artifacts: {} };

  const raw = JSON.parse(result.stdout);
  const parsed = RemoteArtifactManifestSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const legacy = LegacyRemoteManifestSchema.safeParse(raw);
  if (legacy.success) {
    return {
      version: legacy.data.version,
      artifacts: {
        [agentArtifactKey(legacy.data)]: {
          kind: "agent",
          name: "agent",
          version: legacy.data.version,
          os: legacy.data.os,
          arch: legacy.data.arch,
          path: remoteAgentBinaryPath(legacy.data.version, legacy.data),
          sha256: legacy.data.sha256,
          installedAt: legacy.data.installedAt,
        },
      },
    };
  }

  return { artifacts: {} };
}

async function writeRemoteManifest(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  manifest: RemoteArtifactManifest,
): Promise<void> {
  await runSsh(
    options,
    runner,
    `mkdir -p ${REMOTE_AGENT_ROOT} && cat > ${REMOTE_AGENT_MANIFEST}`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function ensureRemoteArtifact(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  now: () => Date,
  request: ArtifactInstallRequest,
  onProgress?: (event: LspBootstrapProgressEvent) => void,
): Promise<ArtifactEnsureResult> {
  const lockKey = artifactLockKey(options, request.key, request.record.sha256);
  const existing = artifactLocks.get(lockKey);
  if (existing) return existing;

  let pending: Promise<ArtifactEnsureResult>;
  pending = ensureRemoteArtifactUnlocked(options, runner, now, request, onProgress).finally(() => {
    if (artifactLocks.get(lockKey) === pending) {
      artifactLocks.delete(lockKey);
    }
  });
  artifactLocks.set(lockKey, pending);
  return pending;
}

async function ensureRemoteArtifactUnlocked(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  now: () => Date,
  request: ArtifactInstallRequest,
  onProgress?: (event: LspBootstrapProgressEvent) => void,
): Promise<ArtifactEnsureResult> {
  emitProgress(onProgress, { name: request.progressName, phase: "checking" });
  const currentManifest = await readRemoteManifest(options, runner);
  const cached = currentManifest.artifacts[request.key];
  if (cached?.sha256 === request.record.sha256) {
    emitProgress(onProgress, { name: request.progressName, phase: "skipped" });
    emitProgress(onProgress, { name: request.progressName, phase: "ready" });
    return { uploaded: false };
  }

  await request.install();
  const nextManifest = await readRemoteManifest(options, runner);
  nextManifest.artifacts[request.key] = {
    ...request.record,
    installedAt: now().toISOString(),
  };
  await writeRemoteManifest(options, runner, nextManifest);
  emitProgress(onProgress, { name: request.progressName, phase: "pruning" });
  await request.prune();
  emitProgress(onProgress, { name: request.progressName, phase: "ready" });
  return { uploaded: true };
}

async function ensureRemoteNodeRuntime(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  distDir: string,
  now: () => Date,
  node: NodeRuntimeManifestEntry,
  platform: RemoteAgentPlatform,
  onProgress?: (event: LspBootstrapProgressEvent) => void,
): Promise<ArtifactEnsureResult> {
  const remoteDir = remoteNodeRuntimeDir(node, platform);
  const remoteArchive = `${REMOTE_AGENT_ROOT}/cache/${path.basename(node.path)}`;
  return ensureRemoteArtifact(
    options,
    runner,
    now,
    {
      key: nodeArtifactKey(platform),
      record: {
        kind: "node",
        name: "node",
        version: node.version,
        os: platform.os,
        arch: platform.arch,
        path: remoteDir,
        sha256: node.sha256,
        size: node.size,
      },
      progressName: `node-${platform.os}-${platform.arch}`,
      install: async () => {
        await uploadAndVerifyFile({
          options,
          runner,
          localPath: path.resolve(distDir, node.path),
          remotePath: remoteArchive,
          sha256: node.sha256,
          executable: false,
          onProgress,
          progressName: `node-${platform.os}-${platform.arch}`,
        });
        emitProgress(onProgress, {
          name: `node-${platform.os}-${platform.arch}`,
          phase: "extracting",
        });
        await runSsh(
          options,
          runner,
          `rm -rf ${quoteShellArg(remoteDir)} && mkdir -p ${quoteShellArg(remoteDir)} && tar -xzf ${quoteShellArg(remoteArchive)} -C ${quoteShellArg(remoteDir)} --strip-components=1 && rm -f ${quoteShellArg(remoteArchive)} && chmod -R u+rwX,go+rX ${quoteShellArg(remoteDir)}`,
        );
      },
      prune: () =>
        pruneRemoteVersions(
          options,
          runner,
          `${REMOTE_AGENT_ROOT}/runtime/node-*-${platform.os}-${platform.arch}`,
        ),
    },
    onProgress,
  );
}

async function ensureRemoteLspArchive(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  distDir: string,
  now: () => Date,
  lsp: LspBinaryManifestEntry,
  onProgress?: (event: LspBootstrapProgressEvent) => void,
): Promise<ArtifactEnsureResult> {
  const remoteDir = remoteLspBinaryDir(lsp);
  const remoteArchive = `${REMOTE_AGENT_ROOT}/cache/${path.basename(lsp.path)}`;
  return ensureRemoteArtifact(
    options,
    runner,
    now,
    {
      key: lspArtifactKey(lsp.name),
      record: {
        kind: "lsp",
        name: lsp.name,
        version: lsp.version,
        path: remoteDir,
        sha256: lsp.sha256,
        size: lsp.size,
      },
      progressName: lsp.name,
      install: async () => {
        await uploadAndVerifyFile({
          options,
          runner,
          localPath: path.resolve(distDir, lsp.path),
          remotePath: remoteArchive,
          sha256: lsp.sha256,
          executable: false,
          onProgress,
          progressName: lsp.name,
        });
        emitProgress(onProgress, { name: lsp.name, phase: "extracting" });
        await runSsh(
          options,
          runner,
          `rm -rf ${quoteShellArg(remoteDir)} && mkdir -p ${quoteShellArg(remoteDir)} && tar -xzf ${quoteShellArg(remoteArchive)} -C ${quoteShellArg(remoteDir)} && rm -f ${quoteShellArg(remoteArchive)} && chmod -R u+rwX,go+rX ${quoteShellArg(remoteDir)}`,
        );
      },
      prune: () => pruneRemoteVersions(options, runner, `${REMOTE_AGENT_ROOT}/lsp/${lsp.name}-*`),
    },
    onProgress,
  );
}

async function uploadAndVerifyFile(args: {
  readonly options: EnsureRemoteAgentOptions;
  readonly runner: SshBootstrapRunner;
  readonly localPath: string;
  readonly remotePath: string;
  readonly sha256: string;
  readonly executable: boolean;
  readonly progressName?: string;
  readonly onProgress?: (event: LspBootstrapProgressEvent) => void;
}): Promise<void> {
  const remoteDir = path.posix.dirname(args.remotePath);
  await runSsh(
    args.options,
    args.runner,
    `mkdir -p ${quoteShellArg(remoteDir)} && chmod 755 ${REMOTE_AGENT_ROOT} ${quoteShellArg(remoteDir)}`,
  );
  const payload = await fs.readFile(args.localPath);
  if (sha256(payload) !== args.sha256) {
    throw createSshError("server.protocol-error", new Error("local artifact sha256 mismatch"));
  }

  const progressName = args.progressName ?? path.basename(args.remotePath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    emitProgress(args.onProgress, {
      name: progressName,
      phase: "uploading",
      bytesDone: 0,
      bytesTotal: payload.byteLength,
    });
    await uploadFile(args.options, args.runner, args.localPath, args.remotePath, payload, {
      executable: args.executable,
    });
    emitProgress(args.onProgress, {
      name: progressName,
      phase: "uploading",
      bytesDone: payload.byteLength,
      bytesTotal: payload.byteLength,
    });
    emitProgress(args.onProgress, { name: progressName, phase: "verifying" });
    const remoteSha = await remoteSha256(args.options, args.runner, args.remotePath);
    if (remoteSha === args.sha256) return;
  }
  throw createSshError("server.protocol-error", new Error("remote artifact sha256 mismatch"));
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

async function writeRemoteLspLauncher(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  args: {
    readonly launcherPath: string;
    readonly nodePath: string;
    readonly entryPath: string;
  },
): Promise<void> {
  const launcher = [
    "#!/usr/bin/env bash",
    "set -e",
    `exec ${singleQuoteShellArg(args.nodePath)} ${singleQuoteShellArg(args.entryPath)} "$@"`,
    "",
  ].join("\n");
  const launcherDir = path.posix.dirname(args.launcherPath);
  await runSsh(
    options,
    runner,
    `mkdir -p ${quoteShellArg(launcherDir)} && cat > ${quoteShellArg(args.launcherPath)} && chmod 755 ${quoteShellArg(args.launcherPath)}`,
    launcher,
  );
}

async function pruneRemoteVersions(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  pattern: string,
): Promise<void> {
  await runSsh(
    options,
    runner,
    `index=0; for item in $(ls -1dt ${pattern} 2>/dev/null); do index=$((index + 1)); if [ "$index" -gt ${KEEP_REMOTE_VERSIONS} ]; then rm -rf "$item"; fi; done`,
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

function agentArtifactKey(platform: RemoteAgentPlatform): string {
  return `agent:${platform.os}:${platform.arch}`;
}

function nodeArtifactKey(platform: RemoteAgentPlatform): string {
  return `node:${platform.os}:${platform.arch}`;
}

function lspArtifactKey(name: string): string {
  return `lsp:${name}`;
}

function artifactLockKey(options: EnsureRemoteAgentOptions, key: string, sha: string): string {
  return [
    destinationForOptions(options),
    options.port ?? "",
    options.identityFile ?? "",
    options.controlPath ?? "",
    key,
    sha,
  ].join("|");
}

function remoteNodeRuntimeDir(
  node: NodeRuntimeManifestEntry,
  platform: RemoteAgentPlatform,
): string {
  return `${REMOTE_AGENT_ROOT}/runtime/node-${node.version}-${platform.os}-${platform.arch}`;
}

function remoteLspBinaryDir(lsp: LspBinaryManifestEntry): string {
  return `${REMOTE_AGENT_ROOT}/lsp/${lsp.name}-${lsp.version}`;
}

function absoluteRemotePath(remoteHome: string, remotePath: string): string {
  if (remotePath.startsWith("~/")) return `${remoteHome}/${remotePath.slice(2)}`;
  return remotePath;
}

function emitProgress(
  onProgress: ((event: LspBootstrapProgressEvent) => void) | undefined,
  event: LspBootstrapProgressEvent,
): void {
  onProgress?.(event);
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
