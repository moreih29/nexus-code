import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentManifestSchema,
  findAgentBinary,
  findLspBinary,
  findNodeRuntime,
  type LspBinaryManifestEntry,
  type NodeRuntimeManifestEntry,
  type WrapperManifestEntry,
} from "../../../../../shared/agent/manifest";
import { POSIX_CLI_LAUNCHER } from "../../../../../shared/cli/launcher";
import { CODEX_WRAPPER } from "../../../../../shared/codex/wrapper";
import { getAgentDistDir } from "../../getAgentBinDir";
import { createSshError } from "../../pipe";
import {
  BASHENV_CONTENT,
  BASHRC_CONTENT,
  ZLOGIN_CONTENT,
  ZLOGOUT_CONTENT,
  ZPROFILE_CONTENT,
  ZSHENV_CONTENT,
  ZSHRC_CONTENT,
} from "../../runtimeDirs";
import { authenticateSshControlMaster, type SshAuthPromptHandler } from "../auth-pty";
import {
  absoluteRemotePath,
  agentArtifactKey,
  artifactLockKey,
  lspArtifactKey,
  nodeArtifactKey,
  parseUname,
  pruneRemoteVersions,
  readRemoteManifest,
  remoteAgentBinaryPath,
  remoteLspBinaryDir,
  remoteNodeRuntimeDir,
  remoteWrapperBinaryPath,
  wrapperArtifactKey,
  writeRemoteManifest,
} from "./manifest";
import {
  defaultRunner,
  quoteShellArg,
  runSsh,
  singleQuoteShellArg,
  uploadAndVerifyFile,
} from "./transport";
import {
  type EnsureRemoteAgentOptions,
  type EnsureRemoteAgentResult,
  type EnsureRemoteLspServerOptions,
  type EnsureRemoteLspServerResult,
  LOCAL_AGENT_DIST_DIR,
  LSP_BOOTSTRAP_PROGRESS_EVENT,
  type LspBootstrapProgressEvent,
  type LspBootstrapProgressPhase,
  REMOTE_AGENT_BOOTSTRAP_TIMEOUT_MS,
  REMOTE_AGENT_MANIFEST,
  REMOTE_AGENT_PROTOCOL_MAJOR,
  REMOTE_AGENT_ROOT,
  REMOTE_AGENT_VERSION,
  type RemoteAgentPlatform,
  type SshBootstrapDependencies,
  type SshBootstrapRunner,
  type SshBootstrapRunnerResult,
} from "./types";

export type {
  EnsureRemoteAgentOptions,
  EnsureRemoteAgentResult,
  EnsureRemoteLspServerOptions,
  EnsureRemoteLspServerResult,
  LspBootstrapProgressEvent,
  LspBootstrapProgressPhase,
  RemoteAgentPlatform,
  SshBootstrapDependencies,
  SshBootstrapRunner,
  SshBootstrapRunnerResult,
};
export {
  LOCAL_AGENT_DIST_DIR,
  LSP_BOOTSTRAP_PROGRESS_EVENT,
  parseUname,
  REMOTE_AGENT_MANIFEST,
  REMOTE_AGENT_PROTOCOL_MAJOR,
  REMOTE_AGENT_ROOT,
  REMOTE_AGENT_VERSION,
  remoteAgentBinaryPath,
};

interface ArtifactInstallRequest {
  readonly key: string;
  readonly record: Omit<
    Awaited<ReturnType<typeof readRemoteManifest>>["artifacts"][string],
    "installedAt"
  >;
  readonly install: () => Promise<void>;
  readonly prune: () => Promise<void>;
  readonly progressName: string;
}

interface ArtifactEnsureResult {
  readonly uploaded: boolean;
}

const artifactLocks = new Map<
  string,
  { ready: Promise<ArtifactEnsureResult>; signal?: AbortSignal }
>();

export async function ensureRemoteAgent(
  options: EnsureRemoteAgentOptions,
  dependencies: SshBootstrapDependencies = {},
): Promise<EnsureRemoteAgentResult> {
  const context = await createBootstrapContext(options, dependencies);
  const { distDir, now, authenticatedMaster } = context;
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(
      createSshError(
        "transport.timeout",
        new Error(`Remote agent bootstrap exceeded ${REMOTE_AGENT_BOOTSTRAP_TIMEOUT_MS}ms`),
      ),
    );
  }, REMOTE_AGENT_BOOTSTRAP_TIMEOUT_MS);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const sshOptions = { ...context.sshOptions, signal };
  const runner: SshBootstrapRunner = (command, args, input) =>
    untilAborted(() => context.runner(command, args, input, signal), signal);

  try {
    signal.throwIfAborted();
    const localManifest = AgentManifestSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(distDir, "manifest.json"), { encoding: "utf8", signal }),
      ),
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
            remoteAgentRoot: REMOTE_AGENT_ROOT,
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

    const remoteHome = await detectRemoteHome(sshOptions, runner);
    const remoteShell = await detectRemoteShell(sshOptions, runner);

    if (localManifest.wrapper) {
      await ensureRemoteWrapper(
        sshOptions,
        runner,
        now,
        distDir,
        localManifest.wrapper,
        dependencies.onProgress,
      );
    }

    const remoteBinDir = absoluteRemotePath(remoteHome, `${REMOTE_AGENT_ROOT}/bin`);
    await writeRemoteCliLauncher(sshOptions, runner, remoteBinDir);

    const remoteShimDir = options.workspaceId
      ? await ensureRemoteShimFiles(sshOptions, runner, remoteHome)
      : undefined;

    signal.throwIfAborted();
    return {
      remoteCommand: buildRemoteAgentCommand(remoteBinaryPath, options.remotePath),
      remoteHome,
      platform,
      uploaded: ensured.uploaded,
      controlPath: authenticatedMaster?.controlPath ?? options.controlPath,
      dispose: authenticatedMaster ? () => authenticatedMaster.dispose() : undefined,
      remoteBinDir,
      ...(remoteShell !== undefined ? { remoteShell } : {}),
      ...(remoteShimDir !== undefined ? { remoteShimDir } : {}),
    };
  } catch (error) {
    authenticatedMaster?.dispose();
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(timer);
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

    dependencies.onProgress?.({ name: lsp.name, phase: "linking" });
    await writeRemoteLspLauncher(sshOptions, runner, {
      launcherPath: lspLauncherPath,
      nodePath,
      entryPath: lspEntryPath,
    });
    dependencies.onProgress?.({ name: lsp.name, phase: "ready" });

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

export function buildRemoteAgentCommand(binaryPath: string, remotePath: string): string {
  if (!remotePath.startsWith("/")) {
    throw createSshError(
      "server.protocol-error",
      new Error(`remotePath must be an absolute path, got: ${JSON.stringify(remotePath)}`),
    );
  }
  const bin = quoteShellArg(binaryPath);
  const root = quoteShellArg(remotePath);

  const script =
    `p=0; while :; do ` +
    `( ${bin} --daemon ${root} </dev/null >/dev/null 2>&1 & ); ` +
    `${bin} --dial-workspace ${root}; rc=$?; ` +
    `if [ $rc -ne 4 ]; then exit $rc; fi; ` +
    `p=$((p+1)); if [ $p -ge 25 ]; then exit 4; fi; sleep 0.2; ` +
    `done`;
  return `bash -lc ${singleQuoteShellArg(script)}`;
}

async function untilAborted<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return run();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run();
    });
    return await Promise.race([cancelled, result]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
  options.signal?.throwIfAborted();
  const runner = dependencies.runner ?? defaultRunner;
  const distDir = dependencies.distDir ?? getAgentDistDir();
  const now = dependencies.now ?? (() => new Date());
  const shouldAuthenticate =
    options.authMode === "interactive" && dependencies.promptHandler && !options.controlPath;
  const authenticatedMaster = shouldAuthenticate
    ? await authenticateSshControlMaster(
        options,
        dependencies.promptHandler as SshAuthPromptHandler,
        { ...dependencies.auth, signal: options.signal },
      )
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

async function detectRemoteShell(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
): Promise<string | undefined> {
  try {
    const result = await runSsh(options, runner, `echo "$SHELL"`);
    const shell = result.stdout.trim();
    return shell.startsWith("/") ? shell : undefined;
  } catch {
    return undefined;
  }
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
  if (existing) {
    try {
      return await untilAborted(() => existing.ready, options.signal);
    } catch (error) {
      if (existing.signal?.aborted && !options.signal?.aborted) {
        return ensureRemoteArtifact(options, runner, now, request, onProgress);
      }
      throw error;
    }
  }

  const pending = ensureRemoteArtifactUnlocked(options, runner, now, request, onProgress).finally(
    () => {
      if (artifactLocks.get(lockKey)?.ready === pending) {
        artifactLocks.delete(lockKey);
      }
    },
  );
  artifactLocks.set(lockKey, { ready: pending, signal: options.signal });
  return pending;
}

async function ensureRemoteArtifactUnlocked(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  now: () => Date,
  request: ArtifactInstallRequest,
  onProgress?: (event: LspBootstrapProgressEvent) => void,
): Promise<ArtifactEnsureResult> {
  onProgress?.({ name: request.progressName, phase: "checking" });
  const currentManifest = await readRemoteManifest(options, runner);
  const cached = currentManifest.artifacts[request.key];
  if (cached?.sha256 === request.record.sha256) {
    onProgress?.({ name: request.progressName, phase: "skipped" });
    onProgress?.({ name: request.progressName, phase: "ready" });
    return { uploaded: false };
  }

  await request.install();
  const nextManifest = await readRemoteManifest(options, runner);
  nextManifest.artifacts[request.key] = {
    ...request.record,
    installedAt: now().toISOString(),
  };
  await writeRemoteManifest(options, runner, nextManifest);
  onProgress?.({ name: request.progressName, phase: "pruning" });
  await request.prune();
  onProgress?.({ name: request.progressName, phase: "ready" });
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
          remoteAgentRoot: REMOTE_AGENT_ROOT,
        });
        onProgress?.({
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
          remoteAgentRoot: REMOTE_AGENT_ROOT,
        });
        onProgress?.({ name: lsp.name, phase: "extracting" });
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

const SHIM_FILES: ReadonlyArray<{ readonly name: string; readonly content: string }> = [
  { name: ".zshrc", content: ZSHRC_CONTENT },
  { name: ".zshenv", content: ZSHENV_CONTENT },
  { name: ".zprofile", content: ZPROFILE_CONTENT },
  { name: ".zlogin", content: ZLOGIN_CONTENT },
  { name: ".zlogout", content: ZLOGOUT_CONTENT },
  { name: "bashrc", content: BASHRC_CONTENT },
  { name: "bashenv", content: BASHENV_CONTENT },
];

const SHIM_DIR_NAME = "shared";

async function ensureRemoteShimFiles(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  remoteHome: string,
): Promise<string> {
  const remoteShimDir = absoluteRemotePath(
    remoteHome,
    `${REMOTE_AGENT_ROOT}/shim/${SHIM_DIR_NAME}`,
  );
  await runSsh(options, runner, `mkdir -p ${quoteShellArg(remoteShimDir)}`);

  for (const file of SHIM_FILES) {
    const remotePath = `${remoteShimDir}/${file.name}`;
    const tmpRemotePath = `${remotePath}.tmp.${randomBytes(6).toString("hex")}`;
    await runSsh(
      options,
      runner,
      `cat > ${quoteShellArg(tmpRemotePath)} && mv -f ${quoteShellArg(tmpRemotePath)} ${quoteShellArg(remotePath)}`,
      file.content,
    );
  }

  return remoteShimDir;
}

async function writeRemoteCliLauncher(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  remoteBinDir: string,
): Promise<void> {
  for (const [name, script] of [
    ["nexus", POSIX_CLI_LAUNCHER],
    ["codex", CODEX_WRAPPER],
  ] as const) {
    const scriptPath = quoteShellArg(`${remoteBinDir}/${name}`);
    await runSsh(
      options,
      runner,
      `mkdir -p ${quoteShellArg(remoteBinDir)} && cat > ${scriptPath} && chmod 755 ${scriptPath}`,
      script,
    );
  }
}

async function ensureRemoteWrapper(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  now: () => Date,
  distDir: string,
  wrapper: WrapperManifestEntry,
  onProgress?: (event: LspBootstrapProgressEvent) => void,
): Promise<ArtifactEnsureResult> {
  const remotePath = remoteWrapperBinaryPath();
  return ensureRemoteArtifact(
    options,
    runner,
    now,
    {
      key: wrapperArtifactKey(),
      record: {
        kind: "wrapper",
        name: "claude",
        version: "0",
        path: remotePath,
        sha256: wrapper.sha256,
        size: wrapper.size,
      },
      progressName: "claude-wrapper",
      install: () =>
        uploadAndVerifyFile({
          options,
          runner,
          localPath: path.resolve(distDir, wrapper.path),
          remotePath,
          sha256: wrapper.sha256,
          executable: true,
          remoteAgentRoot: REMOTE_AGENT_ROOT,
        }),
      prune: () => Promise.resolve(),
    },
    onProgress,
  );
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
