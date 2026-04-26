import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";

export const OPENCODE_HOST = "127.0.0.1";
export const OPENCODE_PORT_BASE = 43_000;
export const OPENCODE_PORT_SPAN = 2_000;
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
export const NEXUS_OPENCODE_HOST_ENV = "NEXUS_OPENCODE_HOST";
export const NEXUS_OPENCODE_PORT_ENV = "NEXUS_OPENCODE_PORT";
export const NEXUS_OPENCODE_SHIM_DIR_ENV = "NEXUS_OPENCODE_SHIM_DIR";
export const NEXUS_OPENCODE_ORIGINAL_PATH_ENV = "NEXUS_OPENCODE_ORIGINAL_PATH";

export interface OpenCodeTerminalEnvOptions {
  readonly shimDir?: string;
  readonly basePath?: string;
}

export interface OpenCodeShimOptions {
  readonly dataDir: string;
  readonly workspaceId: WorkspaceId;
}

export function resolveOpenCodePort(workspaceId: WorkspaceId): number {
  const digest = createHash("sha256").update(workspaceId, "utf8").digest("hex");
  const value = Number.parseInt(digest.slice(0, 8), 16);
  return OPENCODE_PORT_BASE + (value % OPENCODE_PORT_SPAN);
}

export function buildOpenCodeConfigContent(workspaceId: WorkspaceId): string {
  return JSON.stringify({
    server: {
      hostname: OPENCODE_HOST,
      port: resolveOpenCodePort(workspaceId),
    },
  });
}

export function buildOpenCodeTerminalEnvOverrides(
  workspaceId: WorkspaceId,
  options: OpenCodeTerminalEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {
    [OPENCODE_CONFIG_CONTENT_ENV]: buildOpenCodeConfigContent(workspaceId),
    [NEXUS_OPENCODE_HOST_ENV]: OPENCODE_HOST,
    [NEXUS_OPENCODE_PORT_ENV]: String(resolveOpenCodePort(workspaceId)),
  };

  if (options.shimDir) {
    env[NEXUS_OPENCODE_SHIM_DIR_ENV] = options.shimDir;
    env[NEXUS_OPENCODE_ORIGINAL_PATH_ENV] = options.basePath ?? "";
    env.PATH = prependPath(options.shimDir, options.basePath ?? "");
  }

  return env;
}

export async function ensureOpenCodeWorkspaceShim(
  options: OpenCodeShimOptions,
): Promise<string> {
  const shimDir = openCodeShimDir(options.dataDir, options.workspaceId);
  await mkdir(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, "opencode");
  await writeFile(shimPath, buildOpenCodeShimScript(), "utf8");
  await chmod(shimPath, 0o755);
  return shimDir;
}

export function openCodeShimDir(dataDir: string, workspaceId: WorkspaceId): string {
  return path.join(dataDir, "opencode-shims", workspaceId);
}

export function buildOpenCodeShimScript(): string {
  return `#!/bin/sh
set -eu

host=\${${NEXUS_OPENCODE_HOST_ENV}:-${OPENCODE_HOST}}
port=\${${NEXUS_OPENCODE_PORT_ENV}:?Nexus OpenCode shim missing ${NEXUS_OPENCODE_PORT_ENV}}
original_path=\${${NEXUS_OPENCODE_ORIGINAL_PATH_ENV}:-}

if [ -z "$original_path" ]; then
  echo "Nexus OpenCode shim: ${NEXUS_OPENCODE_ORIGINAL_PATH_ENV} is empty; cannot locate real opencode." >&2
  exit 127
fi

old_ifs=$IFS
IFS=:
for dir in $original_path; do
  IFS=$old_ifs
  [ -n "$dir" ] || dir=.
  candidate="$dir/opencode"
  if [ -x "$candidate" ]; then
    exec "$candidate" --hostname "$host" --port "$port" "$@"
  fi
  IFS=:
done
IFS=$old_ifs

echo "Nexus OpenCode shim: real opencode binary not found on PATH." >&2
exit 127
`;
}

function prependPath(prefix: string, basePath: string): string {
  return basePath.trim().length > 0 ? `${prefix}:${basePath}` : prefix;
}
