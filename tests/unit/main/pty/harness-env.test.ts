/**
 * injectHarnessTerminalEnv() 단위 테스트.
 *
 * getAgentBinDir() 가 electron.app.isPackaged 를 사용하므로
 * mock.module("electron")을 먼저 선언하고 dynamic import로 대상 모듈을 로드한다.
 */

import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { LOCAL_AGENT_DIST_DIR } from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/types";

// -------------------------------------------------------------------------
// electron mock — 모든 import보다 먼저 위치해야 mock이 올바르게 적용된다.
// isPackaged=false(dev 모드)로 고정하여 경로를 결정론적으로 만든다.
// -------------------------------------------------------------------------
mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

// mock.module 이후 dynamic import로 대상 모듈 로드.
const { injectHarnessTerminalEnv } = await import(
  "../../../../src/main/features/pty/harness-env"
);

// isPackaged=false 시 getAgentBinDir()가 반환하는 경로.
const EXPECTED_BIN_DIR = path.join(LOCAL_AGENT_DIST_DIR, "bin");

describe("injectHarnessTerminalEnv — 기존 TERM_PROGRAM 동작 유지", () => {
  test("undefined input → ghostty 기본값 + NEXUS_IN_APP 포함", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.TERM_PROGRAM).toBe("ghostty");
    expect(result.TERM_PROGRAM_VERSION).toBe("1.0");
    expect(result.NEXUS_IN_APP).toBe("1");
  });

  test("caller-supplied TERM_PROGRAM 보존", () => {
    const result = injectHarnessTerminalEnv({ TERM_PROGRAM: "iTerm.app" });
    expect(result.TERM_PROGRAM).toBe("iTerm.app");
    expect(result.TERM_PROGRAM_VERSION).toBe("1.0");
  });

  test("caller-supplied TERM_PROGRAM_VERSION 보존", () => {
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

describe("injectHarnessTerminalEnv — PATH prepend", () => {
  test("PATH 앞에 getAgentBinDir() prepend (base 레벨)", () => {
    // env에 PATH 없을 때 base PATH에 binDir이 포함된다.
    const result = injectHarnessTerminalEnv({});
    expect(result.PATH).toContain(EXPECTED_BIN_DIR);
    expect(result.PATH?.startsWith(EXPECTED_BIN_DIR)).toBe(true);
  });

  test("caller PATH가 없을 때 base PATH가 설정됨", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.PATH).toContain(EXPECTED_BIN_DIR);
  });

  test("caller PATH를 직접 설정하면 caller 값이 우선(spread 규칙)", () => {
    // 기존 패턴: caller key가 이긴다.
    const callerPath = "/custom/bin:/usr/local/bin";
    const result = injectHarnessTerminalEnv({ PATH: callerPath });
    expect(result.PATH).toBe(callerPath);
  });
});

describe("injectHarnessTerminalEnv — NEXUS_* 주입", () => {
  test("NEXUS_IN_APP=1 항상 주입", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.NEXUS_IN_APP).toBe("1");
  });

  test("NEXUS_WRAPPER_SELF_DIR = getAgentBinDir()", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.NEXUS_WRAPPER_SELF_DIR).toBe(EXPECTED_BIN_DIR);
  });

  test("context.workspaceId / tabId 주입", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      workspaceId: "ws-1",
      tabId: "tab-2",
    });
    expect(result.NEXUS_WORKSPACE_ID).toBe("ws-1");
    expect(result.NEXUS_TAB_ID).toBe("tab-2");
  });

  test("context.agentBin 제공 시 NEXUS_AGENT_BIN 설정", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      workspaceId: "ws-1",
      tabId: "tab-1",
      agentBin: "/path/to/agent-bin",
    });
    expect(result.NEXUS_AGENT_BIN).toBe("/path/to/agent-bin");
  });

  test("context.agentBin 미제공 시 NEXUS_AGENT_BIN 미설정", () => {
    const result = injectHarnessTerminalEnv(undefined, {
      workspaceId: "ws-1",
      tabId: "tab-1",
    });
    expect(result.NEXUS_AGENT_BIN).toBeUndefined();
  });

  test("context.agentSocket / hookToken 제공 시 설정", () => {
    const result = injectHarnessTerminalEnv(undefined, {
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
      { workspaceId: "ws-1", tabId: "tab-1" },
    );
    // caller env가 spread에서 이긴다.
    expect(result.NEXUS_IN_APP).toBe("0");
    expect(result.NEXUS_WORKSPACE_ID).toBe("caller-ws");
  });
});

describe("injectHarnessTerminalEnv — context 미제공", () => {
  test("context 없으면 NEXUS_WORKSPACE_ID / TAB_ID 미설정", () => {
    const result = injectHarnessTerminalEnv(undefined);
    expect(result.NEXUS_WORKSPACE_ID).toBeUndefined();
    expect(result.NEXUS_TAB_ID).toBeUndefined();
  });
});
