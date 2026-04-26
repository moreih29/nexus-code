import { createHash } from "node:crypto";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";

export const OPENCODE_HOST = "127.0.0.1";
export const OPENCODE_PORT_BASE = 43_000;
export const OPENCODE_PORT_SPAN = 2_000;
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

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

export function buildOpenCodeTerminalEnvOverrides(workspaceId: WorkspaceId): Record<string, string> {
  return {
    [OPENCODE_CONFIG_CONTENT_ENV]: buildOpenCodeConfigContent(workspaceId),
  };
}
