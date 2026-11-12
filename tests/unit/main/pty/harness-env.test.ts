/**
 * injectHarnessTerminalEnv() 단위 테스트.
 *
 * T5 시그니처 변경: binDir은 HarnessTerminalEnvContext의 필수 필드로 이동.
 * getAgentBinDir() 직접 호출이 제거되었으므로 electron mock 없이 테스트 가능하다.
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
