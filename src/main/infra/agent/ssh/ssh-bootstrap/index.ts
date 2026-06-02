/**
 * Bootstrap orchestrator for the remote agent and LSP servers.
 *
 * Responsibility: drive the install/upgrade workflow on the remote host so
 * by the time the caller spawns its NDJSON channel, the agent binary (and
 * any required Node runtime + LSP archive) are present and verified.
 *
 * The actual transport (ssh/sftp shelling, uploads, sha256 verification) and
 * the persisted manifest format live in `./ssh-bootstrap/transport.ts` and
 * `./ssh-bootstrap/manifest.ts` respectively. This file owns the
 * orchestration and the public surface — type and constant re-exports stay
 * here so existing callers keep their import paths.
 */
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
import { getAgentDistDir } from "../../getAgentBinDir";
import { createSshError } from "../../pipe";
import { BASHRC_CONTENT, ZSHENV_CONTENT, ZSHRC_CONTENT } from "../../runtimeDirs";
import {
  type AuthenticateSshControlMasterDependencies,
  authenticateSshControlMaster,
  type SshAuthPromptHandler,
} from "../auth-pty";
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
// Re-export the stable public surface so existing callers keep their import
// paths (`"./ssh-bootstrap"`) unchanged.
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

// Process-wide deduplication of concurrent ensure() calls for the same
// artifact on the same remote. Each key resolves to the in-flight promise
// so multiple workspaces booting against the same host upload once.
const artifactLocks = new Map<string, Promise<ArtifactEnsureResult>>();

/**
 * Ensures the agent binary is present at the canonical path on the remote.
 * The returned `remoteCommand` is the exact command line to spawn over the
 * NDJSON channel; on auth failure or sha mismatch the ControlMaster is
 * disposed before the error propagates.
 */
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

    // PTY shim files: only when the caller scoped the bootstrap to a
    // workspace (the PTY spawn path always does; the LSP path does not).
    // We mirror runtimeDirs.shimDir's `<root>/shim/<workspaceId>` layout on
    // the remote so the spawned shell's ZDOTDIR / --rcfile points at a path
    // that actually exists there. The content is workspace-agnostic —
    // every shim file is the same bytes, only the directory is per-workspace.
    const remoteShimDir = options.workspaceId
      ? await ensureRemoteShimFiles(sshOptions, runner, remoteHome, options.workspaceId)
      : undefined;

    // On success, ownership of a ControlMaster authenticated *here* passes to
    // the caller via `dispose`. When the caller supplied its own controlPath
    // (a reused master), we surface that path back but no dispose handle —
    // the caller already owns that socket's lifecycle.
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
    // This function never returned, so the caller has no dispose handle.
    // Dispose the ControlMaster here before propagating the error.
    authenticatedMaster?.dispose();
    throw error;
  }
}

/**
 * Ensures both the Node runtime and the requested LSP archive are present
 * on the remote, then writes the per-language launcher that wires them
 * together. Returns the launcher path so the caller can spawn it directly.
 */
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

/**
 * Composes the `bash -lc 'exec ...'` line used to spawn the agent.
 *
 * `remotePath` must be an absolute POSIX path — the agent uses it as its fs
 * root, so a relative path or `~` literal would silently mis-root the agent
 * and cause every subsequent fs call to resolve against an unexpected base.
 */
export function buildRemoteAgentCommand(binaryPath: string, remotePath: string): string {
  if (!remotePath.startsWith("/")) {
    throw createSshError(
      "server.protocol-error",
      new Error(`remotePath must be an absolute path, got: ${JSON.stringify(remotePath)}`),
    );
  }
  // Retry the exec on ETXTBSY ("Text file busy"): immediately after a fresh
  // install (sftp/cat write + `mv` into place) the kernel can briefly refuse to
  // execute the binary while a writer fd from the upload — or a lingering writer
  // from a previous, half-dead bootstrap connection — is still open. `exec`
  // replaces the shell on success (so the loop body never runs twice in the
  // healthy case); it only returns on failure, where we retry a handful of
  // times over ~5s before giving up with the conventional 126 "cannot execute".
  // `shopt -s execfail` is REQUIRED: without it a failed `exec` in a
  // non-interactive bash terminates the shell immediately (so the loop would
  // never retry). With it, a failed exec returns control and the loop runs.
  const exec = `exec ${quoteShellArg(binaryPath)} ${quoteShellArg(remotePath)}`;
  const script =
    `shopt -s execfail; n=0; while :; do ${exec}; n=$((n+1)); ` +
    `if [ "$n" -ge 25 ]; then exit 126; fi; sleep 0.2; done`;
  return `bash -lc ${singleQuoteShellArg(script)}`;
}

/**
 * Resolves the dependency defaults and, when this is the first call against
 * this remote in interactive mode, opens the ControlMaster up front so every
 * subsequent ssh/sftp invocation rides the same socket.
 */
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
  const distDir = dependencies.distDir ?? getAgentDistDir();
  const now = dependencies.now ?? (() => new Date());
  const shouldAuthenticate =
    options.authMode === "interactive" && dependencies.promptHandler && !options.controlPath;
  const authenticatedMaster = shouldAuthenticate
    ? await authenticateSshControlMaster(
        options,
        dependencies.promptHandler as SshAuthPromptHandler,
        dependencies.auth as AuthenticateSshControlMasterDependencies | undefined,
      )
    : null;
  const sshOptions = authenticatedMaster
    ? { ...options, controlPath: authenticatedMaster.controlPath }
    : options;
  return { runner, distDir, now, sshOptions, authenticatedMaster };
}

/** Runs `uname -ms` on the remote and parses it into the platform tuple. */
async function detectRemotePlatform(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
): Promise<RemoteAgentPlatform> {
  const result = await runSsh(options, runner, "uname -ms");
  return parseUname(result.stdout);
}

/** Reads the remote $HOME so `~/`-prefixed paths can be resolved client-side. */
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

/**
 * Reads the remote `$SHELL` so the PTY layer can decide whether to install
 * the per-workspace zsh/bash shim on that workspace's spawned shells.
 *
 * Best-effort: when `$SHELL` is unset on the remote or the command fails for
 * any reason, returns `undefined` instead of throwing. The caller treats
 * `undefined` as "skip shim activation" — the spawn-time PATH prepend still
 * applies, only the precmd hook is forgone. We use `echo` (not `printf`) to
 * keep the command shape clearly distinct from `detectRemoteHome` for tests
 * and tracing.
 */
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

/**
 * Deduplicating ensure() entry point. The lock map coalesces concurrent
 * calls into one upload, so two workspaces racing to boot share one
 * verify/install pass.
 */
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

  const pending = ensureRemoteArtifactUnlocked(options, runner, now, request, onProgress).finally(
    () => {
      if (artifactLocks.get(lockKey) === pending) {
        artifactLocks.delete(lockKey);
      }
    },
  );
  artifactLocks.set(lockKey, pending);
  return pending;
}

/**
 * Runs one ensure() pass without the dedupe lock. Reads the remote manifest,
 * compares sha256, installs if needed, updates the manifest, then prunes.
 */
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

/** Uploads the Node runtime archive and extracts it into its versioned dir. */
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

/** Uploads an LSP archive and extracts it into its versioned dir. */
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

/**
 * Uploads the per-workspace PTY shim rc files (`.zshrc`, `.zshenv`, `bashrc`)
 * to `<remoteHome>/.nexus-code/shim/<workspaceId>/` and returns that
 * directory's absolute path. The content of every file is identical to what
 * `runtimeDirs.writeShimFiles()` writes locally — both ends share the same
 * exported constants (`ZSHRC_CONTENT` / `ZSHENV_CONTENT` / `BASHRC_CONTENT`)
 * so there is exactly one source of truth.
 *
 * The shim files reference runtime env vars (`NEXUS_USER_ZDOTDIR` /
 * `NEXUS_WRAPPER_SELF_DIR`) only, so a single write is correct for any
 * subsequent spawn against this workspace — no per-spawn re-upload needed.
 *
 * Each file is written via `cat > path` with the content streamed as
 * runner stdin, matching the existing pattern used for `manifest.json`
 * and the LSP launcher script. Idempotent: re-runs overwrite in place.
 */
async function ensureRemoteShimFiles(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  remoteHome: string,
  workspaceId: string,
): Promise<string> {
  const remoteShimDir = absoluteRemotePath(remoteHome, `${REMOTE_AGENT_ROOT}/shim/${workspaceId}`);
  // mkdir -p first; subsequent `cat > <file>` will inherit the 0o700-ish
  // umask of the remote user. We do not chmod the files explicitly —
  // they are plain rc files, not executables, and the default user-owned
  // mode is sufficient.
  await runSsh(options, runner, `mkdir -p ${quoteShellArg(remoteShimDir)}`);

  const files: ReadonlyArray<{ name: string; content: string }> = [
    { name: ".zshrc", content: ZSHRC_CONTENT },
    { name: ".zshenv", content: ZSHENV_CONTENT },
    { name: "bashrc", content: BASHRC_CONTENT },
  ];

  for (const file of files) {
    const remotePath = `${remoteShimDir}/${file.name}`;
    await runSsh(options, runner, `cat > ${quoteShellArg(remotePath)}`, file.content);
  }

  return remoteShimDir;
}

/** Uploads the Claude wrapper binary to the fixed remote path `~/.nexus-code/bin/claude`. */
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

/** Writes a bash launcher that execs node with the LSP entry path. */
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
