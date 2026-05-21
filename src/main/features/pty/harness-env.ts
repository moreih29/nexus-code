// Terminal environment injector — ensures PTY sessions carry the identifiers
// that enable OSC 9 notification emission in Claude Code and similar tools.
// T2 확장: PATH prepend + NEXUS_* 환경 변수 주입.

const HARNESS_TERM_PROGRAM = "ghostty";
const HARNESS_TERM_PROGRAM_VERSION = "1.0";

/**
 * injectHarnessTerminalEnv 에 전달하는 컨텍스트 인자.
 *
 * - binDir: 래퍼 바이너리가 위치하는 bin 디렉터리의 절대 경로 (필수).
 *   PATH prepend와 NEXUS_WRAPPER_SELF_DIR에 사용된다.
 *   호출자가 WorkspaceManager.getWrapperBinDir()로 결정하여 전달한다.
 * - workspaceId / tabId: PTY 스폰 요청의 식별자. 래퍼가 NEXUS_WORKSPACE_ID /
 *   NEXUS_TAB_ID 로 주입한다.
 * - agentBin: 실행 중인 에이전트 바이너리의 절대 경로 (optional).
 *   제공 시 NEXUS_AGENT_BIN에 설정된다.
 * - agentSocket / hookToken: hookserver 접속 정보. 제공된 경우에만 설정.
 */
export interface HarnessTerminalEnvContext {
  readonly binDir: string;
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
 * 2. PATH — context.binDir 을 맨 앞에 prepend. 기존 PATH 보존.
 * 3. NEXUS_IN_APP=1
 * 4. NEXUS_WRAPPER_SELF_DIR=<context.binDir>
 * 5. NEXUS_AGENT_BIN — context.agentBin 이 제공된 경우에만 설정.
 * 6. NEXUS_WORKSPACE_ID / NEXUS_TAB_ID — context에서 주입.
 * 7. NEXUS_AGENT_SOCKET / NEXUS_HOOK_TOKEN — context에서 제공된 경우에만 설정.
 *
 * caller env가 같은 키를 직접 설정하면 caller 값이 이긴다(spread 순서: 기본 first,
 * caller second — 기존 패턴 유지).
 *
 * 입력 객체는 변경하지 않는다.
 * context가 제공되지 않으면 TERM_PROGRAM / TERM_PROGRAM_VERSION만 기본값으로 설정하고
 * PATH / NEXUS_* 는 주입하지 않는다.
 */
export function injectHarnessTerminalEnv(
  env: Record<string, string> | undefined,
  context?: HarnessTerminalEnvContext,
): Record<string, string> {
  // context가 없으면 PATH prepend와 NEXUS_* 주입을 건너뛴다.
  if (context === undefined) {
    const base: Record<string, string> = {
      TERM_PROGRAM: HARNESS_TERM_PROGRAM,
      TERM_PROGRAM_VERSION: HARNESS_TERM_PROGRAM_VERSION,
    };
    if (env === undefined) return base;
    return { ...base, ...env };
  }

  // PATH prepend: 호출자가 전달한 binDir을 검색 경로 맨 앞에 추가.
  const { binDir } = context;
  const existingPath = env?.PATH ?? process.env.PATH ?? "";
  const prependedPath = existingPath.length > 0 ? `${binDir}:${existingPath}` : binDir;

  // NEXUS_* 기본값 구성.
  const nexusBase: Record<string, string> = {
    NEXUS_IN_APP: "1",
    NEXUS_WRAPPER_SELF_DIR: binDir,
    NEXUS_WORKSPACE_ID: context.workspaceId,
    NEXUS_TAB_ID: context.tabId,
  };

  if (context.agentBin !== undefined) {
    nexusBase.NEXUS_AGENT_BIN = context.agentBin;
  }
  if (context.agentSocket !== undefined) {
    nexusBase.NEXUS_AGENT_SOCKET = context.agentSocket;
  }
  if (context.hookToken !== undefined) {
    nexusBase.NEXUS_HOOK_TOKEN = context.hookToken;
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
