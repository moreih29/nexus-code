// agent.hookServerReady 이벤트 캐시 — 워크스페이스별 소켓 경로와 토큰을 보관한다.
//
// agent boot 시 1회 발사되는 "agent.hookServerReady" 이벤트를 수신해
// { socketPath, token } 을 workspaceId 기준으로 캐싱한다.
// PTY spawn 시 harness-env.ts가 getHookInfo()로 조회해 NEXUS_AGENT_SOCKET /
// NEXUS_HOOK_TOKEN env에 주입한다.

/** 워크스페이스별 hookserver 접속 정보 */
export interface HookServerInfo {
  readonly socketPath: string;
  readonly token: string;
}

/**
 * agent.hookServerReady 이벤트 페이로드 타입 가드.
 * socketPath / token 둘 다 문자열이어야 유효 페이로드로 간주한다.
 */
function isHookServerReadyPayload(
  value: unknown,
): value is { workspaceId?: string; socketPath: string; token: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.socketPath === "string" && typeof v.token === "string";
}

/**
 * 워크스페이스별 hookserver 접속 정보를 메모리에 캐싱한다.
 *
 * - set: "agent.hookServerReady" 페이로드를 수신해 workspaceId별로 저장한다.
 * - getHookInfo: PTY spawn 시 harness-env.ts가 소켓/토큰을 조회할 때 사용한다.
 * - delete: 워크스페이스 제거 시 항목을 삭제한다.
 */
export class AgentReadyCache {
  private readonly cache = new Map<string, HookServerInfo>();

  /**
   * agent.hookServerReady 이벤트 페이로드를 파싱해 캐시에 저장한다.
   * 페이로드가 유효하지 않으면 무시한다.
   */
  handleReadyEvent(workspaceId: string, payload: unknown): void {
    if (!isHookServerReadyPayload(payload)) return;
    this.cache.set(workspaceId, {
      socketPath: payload.socketPath,
      token: payload.token,
    });
  }

  /**
   * workspaceId에 해당하는 hookserver 접속 정보를 반환한다.
   * 아직 받지 못했거나 워크스페이스가 없으면 undefined를 반환한다.
   */
  getHookInfo(workspaceId: string): HookServerInfo | undefined {
    return this.cache.get(workspaceId);
  }

  /**
   * 워크스페이스 제거 시 해당 항목을 캐시에서 삭제한다.
   */
  delete(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }
}
