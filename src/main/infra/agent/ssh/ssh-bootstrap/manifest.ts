/**
 * Manifest schema, persistence, and the path/key derivations used to address
 * remote artifacts. The bootstrap orchestrator reads and writes this
 * manifest on each ensure() pass to skip work the remote already has.
 */
import { z } from "zod";
import {
  AgentArtifactPlatformSchema,
  type LspBinaryManifestEntry,
  type NodeRuntimeManifestEntry,
} from "../../../../../shared/agent/manifest";
import { createSshError } from "../../pipe";
import { runSsh, quoteShellArg } from "./transport";
import {
  KEEP_REMOTE_VERSIONS,
  REMOTE_AGENT_MANIFEST,
  REMOTE_AGENT_ROOT,
  type EnsureRemoteAgentOptions,
  type RemoteAgentPlatform,
  type SshBootstrapRunner,
} from "./types";

export const RemoteArtifactRecordSchema = z.object({
  kind: z.enum(["agent", "node", "lsp", "wrapper"]),
  name: z.string(),
  version: z.string(),
  os: AgentArtifactPlatformSchema.shape.os.optional(),
  arch: AgentArtifactPlatformSchema.shape.arch.optional(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().optional(),
  installedAt: z.string(),
});

export const RemoteArtifactManifestSchema = z.object({
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

export type RemoteArtifactManifest = z.infer<typeof RemoteArtifactManifestSchema>;
export type RemoteArtifactRecord = z.infer<typeof RemoteArtifactRecordSchema>;

/** Returns the cached remote manifest, migrating the legacy single-record schema. */
export async function readRemoteManifest(
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

/** Replaces the remote manifest atomically. */
export async function writeRemoteManifest(
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

/**
 * Deletes versioned directories matching `pattern` past the retention
 * window, keeping the most recent `KEEP_REMOTE_VERSIONS`.
 */
export async function pruneRemoteVersions(
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

/** Maps `uname -ms` output to the typed platform descriptor. */
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

/** Resolves the canonical install path for an agent binary on the remote. */
export function remoteAgentBinaryPath(version: string, platform: RemoteAgentPlatform): string {
  return `${REMOTE_AGENT_ROOT}/bin/agent-${version}-${platform.os}-${platform.arch}`;
}

/** Stable cache key for the agent binary, keyed by platform. */
export function agentArtifactKey(platform: RemoteAgentPlatform): string {
  return `agent:${platform.os}:${platform.arch}`;
}

/** Stable cache key for the Node runtime, keyed by platform. */
export function nodeArtifactKey(platform: RemoteAgentPlatform): string {
  return `node:${platform.os}:${platform.arch}`;
}

/** Stable cache key for an LSP archive, keyed by binary name. */
export function lspArtifactKey(name: string): string {
  return `lsp:${name}`;
}

/**
 * Composes the in-process lock key used to coalesce concurrent ensure()
 * calls for the same artifact on the same remote into one upload.
 */
export function artifactLockKey(
  options: EnsureRemoteAgentOptions,
  key: string,
  sha: string,
): string {
  return [
    options.user ? `${options.user}@${options.host}` : options.host,
    options.port ?? "",
    options.identityFile ?? "",
    options.controlPath ?? "",
    key,
    sha,
  ].join("|");
}

/** Where a Node runtime version unpacks on the remote. */
export function remoteNodeRuntimeDir(
  node: NodeRuntimeManifestEntry,
  platform: RemoteAgentPlatform,
): string {
  return `${REMOTE_AGENT_ROOT}/runtime/node-${node.version}-${platform.os}-${platform.arch}`;
}

/** Where an LSP archive version unpacks on the remote. */
export function remoteLspBinaryDir(lsp: LspBinaryManifestEntry): string {
  return `${REMOTE_AGENT_ROOT}/lsp/${lsp.name}-${lsp.version}`;
}

/** Stable cache key for the wrapper binary. */
export function wrapperArtifactKey(): string {
  return "wrapper:claude";
}

/** The fixed remote path for the wrapper binary. */
export function remoteWrapperBinaryPath(): string {
  return `${REMOTE_AGENT_ROOT}/bin/claude`;
}

/** Resolves a `~/`-prefixed remote path against the resolved $HOME. */
export function absoluteRemotePath(remoteHome: string, remotePath: string): string {
  if (remotePath.startsWith("~/")) return `${remoteHome}/${remotePath.slice(2)}`;
  return remotePath;
}
