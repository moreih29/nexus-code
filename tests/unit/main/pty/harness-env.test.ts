/**
 * injectHarnessTerminalEnv() 단위 테스트.
 *
 * T5 시그니처 변경: binDir은 HarnessTerminalEnvContext의 필수 필드로 이동.
 * getAgentBinDir() 직접 호출이 제거되었으므로 electron mock 없이 테스트 가능하다.
 */

import { describe, expect, test } from "bun:test";
import { injectHarnessTerminalEnv } from "../../../../src/main/features/pty/harness-env";

const FAKE_BIN_DIR = "/fake/agent/bin";

describe("injectHarnessTerminalEnv — 기존 TERM_PROGRAM 동작 유지", () => {
  test("context 없음 + undefined input → ghostty 기본값 포함", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.TERM_PROGRAM).toBe("ghostty");
    expect(result.TERM_PROGRAM_VERSION).toBe("1.0");
  });

  test("context 없음 + caller-supplied TERM_PROGRAM 보존", () => {
    const result = injectHarnessTerminalEnv({ TERM_PROGRAM: "iTerm.app" });
    expect(result.TERM_PROGRAM).toBe("iTerm.app");
    expect(result.TERM_PROGRAM_VERSION).toBe("1.0");
  });

  test("context 없음 + caller-supplied TERM_PROGRAM_VERSION 보존", () => {
    const result = injectHarnessTerminalEnv({ TERM_PROGRAM_VERSION: "2.0" });
    expect(result.TERM_PROGRAM).toBe("ghostty");
    expect(result.TERM_PROGRAM_VERSION).toBe("2.0");
  });

  test("입력 객체 불변", () => {
    const input: Record<string, string> = { OTHER: "value" };
    const original = { ...input };
    injectHarnessTerminalEnv(input);
    expect(input).toEqual(original);
  });
});

describe("injectHarnessTerminalEnv — context 없음 시 PATH/NEXUS_* 미주입", () => {
  test("context 없으면 NEXUS_IN_APP 미설정", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.NEXUS_IN_APP).toBeUndefined();
  });

  test("context 없으면 NEXUS_WRAPPER_SELF_DIR 미설정", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.NEXUS_WRAPPER_SELF_DIR).toBeUndefined();
  });

  test("context 없으면 NEXUS_WORKSPACE_ID / TAB_ID 미설정", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.NEXUS_WORKSPACE_ID).toBeUndefined();
    expect(result.NEXUS_TAB_ID).toBeUndefined();
  });
});

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
    const result = injectHarnessTerminalEnv(
      undefined,
      { binDir: FAKE_BIN_DIR, workspaceId: "ws-1", tabId: "tab-1" },
    );
    expect(result.PATH).toBeUndefined();
  });

  test("caller PATH를 직접 설정하면 caller 값이 우선(spread 규칙)", () => {
    // 기존 패턴: caller key가 이긴다.
    const callerPath = "/custom/bin:/usr/local/bin";
    const result = injectHarnessTerminalEnv(
      { PATH: callerPath },
      { binDir: FAKE_BIN_DIR, workspaceId: "ws-1", tabId: "tab-1" },
    );
    expect(result.PATH).toBe(callerPath);
  });
});

describe("injectHarnessTerminalEnv — NEXUS_* 주입 (acceptance #6, #7)", () => {
  test("acceptance #6: binDir + agentBin 제공 시 NEXUS_WRAPPER_SELF_DIR, NEXUS_AGENT_BIN 설정", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      binDir: "/foo",
      workspaceId: "ws-1",
      tabId: "tab-1",
      agentBin: "/foo/agent",
    });
    expect(result.NEXUS_WRAPPER_SELF_DIR).toBe("/foo");
    expect(result.NEXUS_AGENT_BIN).toBe("/foo/agent");
  });

  test("acceptance #7: binDir만 제공(agentBin optional) — NEXUS_AGENT_BIN 미주입", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      binDir: "/foo",
      workspaceId: "ws-1",
      tabId: "tab-1",
    });
    expect(result.NEXUS_WRAPPER_SELF_DIR).toBe("/foo");
    expect(result.NEXUS_AGENT_BIN).toBeUndefined();
  });

  test("NEXUS_IN_APP=1 항상 주입 (context 있을 때)", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      binDir: FAKE_BIN_DIR,
      workspaceId: "ws-1",
      tabId: "tab-1",
    });
    expect(result.NEXUS_IN_APP).toBe("1");
  });

  test("context.workspaceId / tabId 주입", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      binDir: FAKE_BIN_DIR,
      workspaceId: "ws-1",
      tabId: "tab-2",
    });
    expect(result.NEXUS_WORKSPACE_ID).toBe("ws-1");
    expect(result.NEXUS_TAB_ID).toBe("tab-2");
  });

  test("context.agentSocket / hookToken 제공 시 설정", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      binDir: FAKE_BIN_DIR,
      workspaceId: "ws-1",
      tabId: "tab-1",
      agentSocket: "/tmp/nexus.sock",
      hookToken: "tok-abc",
    });
    expect(result.NEXUS_AGENT_SOCKET).toBe("/tmp/nexus.sock");
    expect(result.NEXUS_HOOK_TOKEN).toBe("tok-abc");
  });

  test("caller NEXUS_* 값이 기본값을 override", () => {
    const result = injectHarnessTerminalEnv(
      { NEXUS_IN_APP: "0", NEXUS_WORKSPACE_ID: "caller-ws" },
      { binDir: FAKE_BIN_DIR, workspaceId: "ws-1", tabId: "tab-1" },
    );
    // caller env가 spread에서 이긴다.
    expect(result.NEXUS_IN_APP).toBe("0");
    expect(result.NEXUS_WORKSPACE_ID).toBe("caller-ws");
  });
});
