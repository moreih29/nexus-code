// Terminal environment injector — ensures PTY sessions carry the identifiers
// that enable OSC 9 notification emission in Claude Code and similar tools.
// T2 확장: PATH prepend + NEXUS_* 환경 변수 주입.

import { getAgentBinDir } from "../../infra/agent/getAgentBinDir";

const HARNESS_TERM_PROGRAM = "ghostty";
const HARNESS_TERM_PROGRAM_VERSION = "1.0";

/**
 * injectHarnessTerminalEnv 에 전달하는 선택적 컨텍스트 인자.
 *
 * - workspaceId / tabId: PTY 스폰 요청의 식별자. 래퍼가 NEXUS_WORKSPACE_ID /
 *   NEXUS_TAB_ID 로 주입한다.
 * - agentBin: 실행 중인 에이전트 바이너리의 절대 경로. 미제공 시 getAgentBinDir()
 *   로 추론한 bin 디렉터리를 PATH에 prepend하지만 NEXUS_AGENT_BIN는 설정하지 않음.
 * - agentSocket / hookToken: T5/T6 hookserver가 보고하는 값. 현재 task에서는
 *   undefined — T6 완성 후 연결 예정.
 */
export interface HarnessTerminalEnvContext {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly agentBin?: string;
  readonly agentSocket?: string;
  readonly hookToken?: string;
}

/**
 * PTY 세션에 필요한 환경 변수를 주입한 새 객체를 반환한다.
 *
 * 주입 규칙:
 * 1. TERM_PROGRAM / TERM_PROGRAM_VERSION — ghostty 기본값, caller 값이 우선.
 * 2. PATH — getAgentBinDir() 을 맨 앞에 prepend. 기존 PATH 보존.
 * 3. NEXUS_IN_APP=1
 * 4. NEXUS_WRAPPER_SELF_DIR=<getAgentBinDir()>
 * 5. NEXUS_AGENT_BIN — context.agentBin 이 제공된 경우에만 설정.
 * 6. NEXUS_WORKSPACE_ID / NEXUS_TAB_ID — context에서 주입.
 * 7. NEXUS_AGENT_SOCKET / NEXUS_HOOK_TOKEN — context에서 제공된 경우에만 설정.
 *
 * caller env가 같은 키를 직접 설정하면 caller 값이 이긴다(spread 순서: 기본 first,
 * caller second — 기존 패턴 유지).
 *
 * 입력 객체는 변경하지 않는다.
 */
export function injectHarnessTerminalEnv(
  env: Record<string, string> | undefined,
  context?: HarnessTerminalEnvContext,
): Record<string, string> {
  // PATH prepend: agent bin 디렉터리를 검색 경로 맨 앞에 추가.
  const binDir = getAgentBinDir();
  const existingPath = env?.PATH ?? process.env.PATH ?? "";
  const prependedPath = existingPath.length > 0 ? `${binDir}:${existingPath}` : binDir;

  // NEXUS_* 기본값 구성.
  const nexusBase: Record<string, string> = {
    NEXUS_IN_APP: "1",
    NEXUS_WRAPPER_SELF_DIR: binDir,
  };

  // context가 있을 때만 해당 키 추가.
  if (context !== undefined) {
    nexusBase.NEXUS_WORKSPACE_ID = context.workspaceId;
    nexusBase.NEXUS_TAB_ID = context.tabId;
    if (context.agentBin !== undefined) {
      nexusBase.NEXUS_AGENT_BIN = context.agentBin;
    }
    if (context.agentSocket !== undefined) {
      nexusBase.NEXUS_AGENT_SOCKET = context.agentSocket;
    }
    if (context.hookToken !== undefined) {
      nexusBase.NEXUS_HOOK_TOKEN = context.hookToken;
    }
  }

  const base: Record<string, string> = {
    TERM_PROGRAM: HARNESS_TERM_PROGRAM,
    TERM_PROGRAM_VERSION: HARNESS_TERM_PROGRAM_VERSION,
    PATH: prependedPath,
    ...nexusBase,
  };

  if (env === undefined) {
    return base;
  }

  // Spread 순서: 기본값 first, caller env second — caller 키가 우선.
  return { ...base, ...env };
}
