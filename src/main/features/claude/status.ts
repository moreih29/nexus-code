// Claude 세션 상태 broker — (workspaceId, tabId) 쌍별 상태를 메모리로 관리하고
// 변경 시 renderer로 broadcast한다.

import { broadcast } from "../../infra/ipc-router";
import type { ClaudeStatus, StatusEntry } from "../../../shared/claude/status";

/** 내부 저장 단위 */
interface StateEntry {
  status: ClaudeStatus;
  message?: string;
  since: number;
  prompt?: string;
}

/** 상태 변경 listener — clear 시 entry는 null. */
export type ClaudeStatusListener = (
  workspaceId: string,
  tabId: string,
  entry: { status: ClaudeStatus; since: number } | null,
) => void;

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

  private readonly listeners = new Set<ClaudeStatusListener>();

  constructor(
    broadcastFn: (channel: string, event: string, args: unknown) => void = broadcast,
  ) {
    this.broadcastFn = broadcastFn;
  }

  /**
   * 특정 (workspaceId, tabId) 의 상태를 설정한다.
   * 이전 상태와 동일하면 broadcast를 발사하지 않는다.
   *
   * prompt: undefined면 이전 프롬프트를 유지하고, null이면 지운다(새 세션).
   */
  set(
    workspaceId: string,
    tabId: string,
    status: ClaudeStatus,
    message?: string,
    prompt?: string | null,
  ): void {
    const key = `${workspaceId}:${tabId}`;
    const prev = this.map.get(key);
    const nextPrompt = prompt === null ? undefined : (prompt ?? prev?.prompt);

    // 상태·메시지·프롬프트가 모두 동일하면 broadcast 생략.
    if (
      prev &&
      prev.status === status &&
      prev.message === message &&
      prev.prompt === nextPrompt
    ) {
      return;
    }

    const since = Date.now();
    this.map.set(key, { status, message, since, prompt: nextPrompt });
    for (const listener of this.listeners) listener(workspaceId, tabId, { status, since });

    const entry: StatusEntry = {
      workspaceId,
      tabId,
      status,
      since,
      ...(message !== undefined ? { message } : {}),
      ...(nextPrompt !== undefined ? { prompt: nextPrompt } : {}),
    };
    this.broadcastFn("claude", "status", entry);
  }

  /**
   * 특정 (workspaceId, tabId) 의 현재 상태를 반환한다. 없으면 null.
   */
  get(workspaceId: string, tabId: string): StateEntry | null {
    return this.map.get(`${workspaceId}:${tabId}`) ?? null;
  }

  /**
   * 특정 (workspaceId, tabId) 항목을 맵에서 제거하고 renderer에 cleared 이벤트를
   * broadcast한다.
   *
   * PTY 세션 종료 / `session-end` hook 시 호출된다. broadcast가 빠지면 renderer
   * 의 useClaudeStatusStore에 마지막 status가 그대로 남아 사이드바 워크스페이스
   * 인디케이터와 탭 인디케이터가 stale running으로 보이는 버그가 발생한다.
   *
   * 존재하지 않는 entry를 clear하는 경우엔 broadcast를 생략한다 (set의 dedupe와
   * 동일한 noise 억제 정책).
   */
  clear(workspaceId: string, tabId: string): void {
    const key = `${workspaceId}:${tabId}`;
    if (!this.map.has(key)) return;
    this.map.delete(key);
    for (const listener of this.listeners) listener(workspaceId, tabId, null);
    this.broadcastFn("claude", "cleared", { workspaceId, tabId });
  }

  /**
   * 특정 workspaceId에 속한 모든 (workspaceId, tabId) 항목을 맵에서 제거하고
   * 각 tab에 대해 cleared 이벤트를 broadcast한다.
   *
   * 사용자가 사이드바 컨텍스트 메뉴에서 "알림 초기화"를 눌렀을 때 호출된다.
   * Claude wrapper hook이 모든 상황을 완벽히 컨트롤하지 못해 인디케이터가 stale
   * 상태(예: 끝났는데 running으로 남음)로 굳는 경우를 사용자가 수동 복구하는 경로다.
   *
   * broker(권위 상태)에서 항목을 지워야 다음 snapshot·재broadcast로 stale 상태가
   * 되살아나지 않는다. 제거할 항목이 없으면 broadcast를 생략한다.
   */
  clearWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}:`;
    for (const key of this.map.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.map.delete(key);
      const tabId = key.slice(prefix.length);
      for (const listener of this.listeners) listener(workspaceId, tabId, null);
      this.broadcastFn("claude", "cleared", { workspaceId, tabId });
    }
  }

  /**
   * 상태가 바뀌거나 지워질 때마다 listener를 부른다(세션 이력 기록용).
   * 반환 함수로 해제한다.
   */
  onChange(listener: ClaudeStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
        ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
      });
    }
    return result;
  }
}
