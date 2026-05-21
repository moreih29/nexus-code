// Claude 세션 상태 broker — (workspaceId, tabId) 쌍별 상태를 메모리로 관리하고
// 변경 시 renderer로 broadcast한다.

import { broadcast } from "../../infra/ipc-router";
import type { ClaudeStatus, StatusEntry } from "../../../shared/claude/status";

/** 내부 저장 단위 */
interface StateEntry {
  status: ClaudeStatus;
  message?: string;
  since: number;
}

/**
 * (workspaceId, tabId) 쌍별 Claude 세션 상태를 관리하는 broker.
 *
 * - set: 상태를 갱신한다. 이전 값과 동일하면 broadcast를 생략한다.
 * - get: 현재 상태를 반환한다. 없으면 null.
 * - clear: 해당 (ws, tab) 항목을 맵에서 제거한다.
 * - snapshot: 현재 모든 항목을 StatusEntry 배열로 반환한다.
 */
export class ClaudeStatusBroker {
  /** 내부 상태 맵 — "workspaceId:tabId" → StateEntry */
  private readonly map = new Map<string, StateEntry>();

  /** 테스트에서 broadcast 함수를 주입할 때 사용한다. */
  private readonly broadcastFn: (channel: string, event: string, args: unknown) => void;

  constructor(
    broadcastFn: (channel: string, event: string, args: unknown) => void = broadcast,
  ) {
    this.broadcastFn = broadcastFn;
  }

  /**
   * 특정 (workspaceId, tabId) 의 상태를 설정한다.
   * 이전 상태와 동일하면 broadcast를 발사하지 않는다.
   */
  set(workspaceId: string, tabId: string, status: ClaudeStatus, message?: string): void {
    const key = `${workspaceId}:${tabId}`;
    const prev = this.map.get(key);

    // 상태와 메시지가 모두 동일하면 broadcast 생략.
    if (prev && prev.status === status && prev.message === message) return;

    const since = Date.now();
    this.map.set(key, { status, message, since });

    const entry: StatusEntry = { workspaceId, tabId, status, since, ...(message !== undefined ? { message } : {}) };
    this.broadcastFn("claude", "status", entry);
  }

  /**
   * 특정 (workspaceId, tabId) 의 현재 상태를 반환한다. 없으면 null.
   */
  get(workspaceId: string, tabId: string): StateEntry | null {
    return this.map.get(`${workspaceId}:${tabId}`) ?? null;
  }

  /**
   * 특정 (workspaceId, tabId) 항목을 맵에서 제거한다.
   * PTY 세션 종료 / 탭 닫기 시 호출해 메모리 누수를 방지한다.
   */
  clear(workspaceId: string, tabId: string): void {
    this.map.delete(`${workspaceId}:${tabId}`);
  }

  /**
   * 현재 모든 (workspaceId, tabId) 상태를 StatusEntry 배열로 반환한다.
   * renderer 초기화 시 1회 snapshot 동기화에 사용한다.
   */
  snapshot(): StatusEntry[] {
    const result: StatusEntry[] = [];
    for (const [key, entry] of this.map) {
      const colonIdx = key.indexOf(":");
      const workspaceId = key.slice(0, colonIdx);
      const tabId = key.slice(colonIdx + 1);
      result.push({
        workspaceId,
        tabId,
        status: entry.status,
        since: entry.since,
        ...(entry.message !== undefined ? { message: entry.message } : {}),
      });
    }
    return result;
  }
}
