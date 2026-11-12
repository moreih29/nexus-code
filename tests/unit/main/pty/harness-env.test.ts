/**
 * Unit tests for injectHarnessTerminalEnv().
 *
 * T5 signature change: binDir moved into a required field of HarnessTerminalEnvContext.
 * Direct calls to getAgentBinDir() were removed, so this can be tested without an electron mock.
 */

import { describe, expect, test } from "bun:test";
import { injectHarnessTerminalEnv } from "../../../../src/main/features/pty/harness-env";

const FAKE_BIN_DIR = "/fake/agent/bin";

describe("injectHarnessTerminalEnv — PATH (left to the agent's host)", () => {
  test("does not set PATH: the agent puts binDir first on its own host's PATH", () => {
    const result = injectHarnessTerminalEnv(
      {},
      { binDir: FAKE_BIN_DIR, workspaceId: "ws-1", tabId: "tab-1" },
    );
    expect(result.PATH).toBeUndefined();
    expect(result.NEXUS_WRAPPER_SELF_DIR).toBe(FAKE_BIN_DIR);
  });

  test("does not send this process's PATH, which an SSH host does not share", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      binDir: FAKE_BIN_DIR,
      workspaceId: "ws-1",
      tabId: "tab-1",
    });
    expect(result.PATH).toBeUndefined();
  });
});
