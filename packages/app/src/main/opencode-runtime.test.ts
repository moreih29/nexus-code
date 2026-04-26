import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import {
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_HOST,
  OPENCODE_PORT_BASE,
  OPENCODE_PORT_SPAN,
  buildOpenCodeConfigContent,
  buildOpenCodeTerminalEnvOverrides,
  resolveOpenCodePort,
} from "./opencode-runtime";

describe("opencode runtime helpers", () => {
  test("resolves deterministic localhost server config per workspace", () => {
    const workspaceId = "ws_alpha" as WorkspaceId;
    const port = resolveOpenCodePort(workspaceId);

    expect(port).toBeGreaterThanOrEqual(OPENCODE_PORT_BASE);
    expect(port).toBeLessThan(OPENCODE_PORT_BASE + OPENCODE_PORT_SPAN);
    expect(resolveOpenCodePort(workspaceId)).toBe(port);
    expect(JSON.parse(buildOpenCodeConfigContent(workspaceId))).toEqual({
      server: {
        hostname: OPENCODE_HOST,
        port,
      },
    });
    expect(buildOpenCodeTerminalEnvOverrides(workspaceId)).toEqual({
      [OPENCODE_CONFIG_CONTENT_ENV]: buildOpenCodeConfigContent(workspaceId),
    });
  });
});
