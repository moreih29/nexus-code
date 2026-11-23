import { randomBytes } from "node:crypto";
import { z } from "zod";
import { NonnegativeIntegerSchema } from "../../../../../../packages/remote-protocol/src/validation";
import {
  AgentArtifactPlatformSchema,
  type LspBinaryManifestEntry,
  type NodeRuntimeManifestEntry,
  SshHostOsSchema,
} from "../../../../../shared/agent/manifest";
import { createSshError } from "../../pipe";
import { quoteShellArg, runSsh, singleQuoteShellArg } from "./transport";
import {
  type EnsureRemoteAgentOptions,
  KEEP_REMOTE_VERSIONS,
  REMOTE_AGENT_MANIFEST,
  REMOTE_AGENT_ROOT,
  type RemoteAgentPlatform,
  type SshBootstrapRunner,
} from "./types";

export const RemoteArtifactRecordSchema = z.object({
  kind: z.enum(["agent", "node", "lsp", "wrapper"]),
  name: z.string(),
  version: z.string(),
  os: SshHostOsSchema.optional(),
  arch: AgentArtifactPlatformSchema.shape.arch.optional(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: NonnegativeIntegerSchema.optional(),
  installedAt: z.string(),
});

export const RemoteArtifactManifestSchema = z.object({
  version: z.string().optional(),
  protocolVersion: z.string().optional(),
  artifacts: z.record(z.string(), RemoteArtifactRecordSchema),
});

const LegacyRemoteManifestSchema = z.object({
  version: z.string(),
  os: SshHostOsSchema,
  arch: AgentArtifactPlatformSchema.shape.arch,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.string(),
});

export type RemoteArtifactManifest = z.infer<typeof RemoteArtifactManifestSchema>;
export type RemoteArtifactRecord = z.infer<typeof RemoteArtifactRecordSchema>;

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

export async function writeRemoteManifest(
  options: EnsureRemoteAgentOptions,
  runner: SshBootstrapRunner,
  manifest: RemoteArtifactManifest,
): Promise<void> {
  const suffix = randomBytes(8).toString("hex");
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  const script = [
    "manifest=$1",
    "temporary=$manifest.tmp.$2",
    '(set -C; : > "$temporary") || exit 1',
    "trap 'rm -f \"$temporary\"' 0",
    "trap 'exit 1' HUP INT TERM",
    'chmod go-rwx "$temporary" || exit 1',
    'if [ -e "$manifest" ] || [ -L "$manifest" ]; then',
    '  [ -f "$manifest" ] && cp -p "$manifest" "$temporary" || exit 1',
    "fi",
    'cat > "$temporary" || exit 1',
    'written=$(wc -c < "$temporary") || exit 1',
    '[ "$((written + 0))" -eq "$3" ] && [ ! -d "$manifest" ] && mv -f "$temporary" "$manifest"',
  ].join("\n");
  await runSsh(
    options,
    runner,
    `mkdir -p ${quoteShellArg(REMOTE_AGENT_ROOT)} && sh -c ${singleQuoteShellArg(script)} sh ${quoteShellArg(REMOTE_AGENT_MANIFEST)} ${suffix} ${Buffer.byteLength(payload)}`,
    payload,
  );
}

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

export function agentArtifactKey(platform: RemoteAgentPlatform): string {
  return `agent:${platform.os}:${platform.arch}`;
}

export function nodeArtifactKey(platform: RemoteAgentPlatform): string {
  return `node:${platform.os}:${platform.arch}`;
}

export function lspArtifactKey(name: string): string {
  return `lsp:${name}`;
}

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

export function remoteNodeRuntimeDir(
  node: NodeRuntimeManifestEntry,
  platform: RemoteAgentPlatform,
): string {
  return `${REMOTE_AGENT_ROOT}/runtime/node-${node.version}-${platform.os}-${platform.arch}`;
}

export function remoteLspBinaryDir(lsp: LspBinaryManifestEntry): string {
  return `${REMOTE_AGENT_ROOT}/lsp/${lsp.name}-${lsp.version}`;
}

export function wrapperArtifactKey(): string {
  return "wrapper:claude";
}

export function remoteWrapperBinaryPath(): string {
  return `${REMOTE_AGENT_ROOT}/bin/claude`;
}

export function absoluteRemotePath(remoteHome: string, remotePath: string): string {
  if (remotePath.startsWith("~/")) return `${remoteHome}/${remotePath.slice(2)}`;
  return remotePath;
}
