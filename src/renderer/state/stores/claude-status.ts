import { create } from "zustand";
import type { ClaudeStatus, StatusEntry } from "../../../shared/claude/status";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

// ---------------------------------------------------------------------------
// 타입 정의
// ---------------------------------------------------------------------------

/**
 * ClaudeStatusStore 인터페이스.
 *
 * byWorkspace: workspaceId → tabId → StatusEntry 의 중첩 record 구조.
 * selector identity 안정성을 위해 변경 없는 set은 state를 그대로 반환한다.
 */
interface ClaudeStatusStore {
  byWorkspace: Record<string, Record<string, StatusEntry>>;
  /**
   * snapshot API 응답으로 byWorkspace 전체를 교체한다.
   * 새 snapshot에 없는 워크스페이스 entry는 제거된다.
   */
  setMany(entries: StatusEntry[]): void;
  /**
   * 단일 (workspaceId, tabId) entry를 갱신한다.
   * 동일한 status·message·since 값이면 state를 변경하지 않아 identity를 유지한다.
   */
  set(entry: StatusEntry): void;
  /**
   * 특정 (workspaceId, tabId) entry를 제거한다.
   */
  clearTab(workspaceId: string, tabId: string): void;
  /**
   * 워크스페이스의 모든 tab entry를 제거한다.
   */
  clearWorkspace(workspaceId: string): void;
}

// ---------------------------------------------------------------------------
// Selector용 안정 fallback 상수 (모듈 수준 고정 — 매 렌더에서 새 참조 생성 방지)
// ---------------------------------------------------------------------------

/** 빈 탭 record의 안정 참조. selector가 undefined 대신 이를 반환한다. */
export const EMPTY_TABS: Record<string, StatusEntry> = {};

// ---------------------------------------------------------------------------
// 우선순위 정렬 헬퍼
// ---------------------------------------------------------------------------

/**
 * 주의 필요 상태 목록. isAttentionRequired와 집계 selector에서 공통으로 사용한다.
 *
 * 주의: completed는 의도적으로 제외한다. completed는 "응답 종료"를 탭 인디케이터로만
 * 표시하고, OS 알림은 hook-handler에서 별도로 발사한다. 사이드바 워크스페이스
 * 집계에는 "사용자 입력이 필요한 진짜 attention"(needsInput/permissionPending/error)
 * 만 잡혀야 한다 — 그렇지 않으면 ClaudeWorkspaceIndicator가 completed를 needsInput
 * 글리프로 렌더하는 부정확한 시각화를 유발한다.
 */
export const ATTENTION_STATUSES: readonly ClaudeStatus[] = [
  "needsInput",
  "permissionPending",
  "error",
];

/**
 * 워크스페이스 카드에 글리프로 표시할 상태 목록. 6개 상태 모두 포함된다.
 *
 * idle도 포함하는 이유: 사용자가 한 번이라도 세션을 시작한 워크스페이스(StatusEntry가 존재)는
 * "사용자가 확인 완료한 dim 상태(회색 체크)"로 표시한다. StatusEntry 자체가 없는
 * 워크스페이스는 wsTabs가 undefined라 호출자(WorkspaceRow)에서 글리프를 렌더하지 않는다.
 *
 * ATTENTION_STATUSES와 구분: ATTENTION_STATUSES는 "사용자 입력이 필요한 상태"의 시맨틱이고,
 * WORKSPACE_VISIBLE_STATUSES는 "카드에 글리프를 렌더할 상태"의 시각화 정책이다.
 */
export const WORKSPACE_VISIBLE_STATUSES: readonly ClaudeStatus[] = [
  "idle",
  "running",
  "completed",
  "needsInput",
  "permissionPending",
  "error",
];

/**
 * 상태 우선순위 매핑.
 * permissionPending(5) > error(4) > needsInput(3) > completed(2) > running(1) > idle(0)
 *
 * completed는 running 위 / needsInput 아래로 둔다. 응답이 끝났음을 알리는 약한 attention.
 */
const STATUS_PRIORITY: Record<ClaudeStatus, number> = {
  idle: 0,
  running: 1,
  completed: 2,
  needsInput: 3,
  error: 4,
  permissionPending: 5,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * renderer 전역 Claude 세션 상태 store.
 *
 * bootstrap 시 snapshot으로 초기화하고, 이후 status 이벤트로 incremental 갱신한다.
 * workspaceId 키 정리는 workspace-cleanup registry를 통해 자동으로 수행된다.
 */
export const useClaudeStatusStore = create<ClaudeStatusStore>((set, get) => {
  // 워크스페이스 제거 시 해당 workspaceId의 모든 entry를 정리한다.
  registerWorkspaceCleanup((workspaceId) => {
    get().clearWorkspace(workspaceId);
  });

  return {
    byWorkspace: {},

    setMany(entries) {
      // entries를 workspaceId → tabId → entry 의 중첩 record로 변환한다.
      const next: Record<string, Record<string, StatusEntry>> = {};
      for (const entry of entries) {
        if (!next[entry.workspaceId]) {
          next[entry.workspaceId] = {};
        }
        next[entry.workspaceId][entry.tabId] = entry;
      }
      set({ byWorkspace: next });
    },

    set(entry) {
      set((state) => {
        const wsRecord = state.byWorkspace[entry.workspaceId];
        const existing = wsRecord?.[entry.tabId];

        // 동일 값이면 state identity를 보존한다 (useSyncExternalStore thrashing 방지).
        if (
          existing !== undefined &&
          existing.status === entry.status &&
          existing.message === entry.message &&
          existing.since === entry.since
        ) {
          return state;
        }

        return {
          byWorkspace: {
            ...state.byWorkspace,
            [entry.workspaceId]: {
              ...(wsRecord ?? {}),
              [entry.tabId]: entry,
            },
          },
        };
      });
    },

    clearTab(workspaceId, tabId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const next = { ...wsRecord };
        delete next[tabId];
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: next,
          },
        };
      });
    },

    clearWorkspace(workspaceId) {
      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const next = { ...state.byWorkspace };
        delete next[workspaceId];
        return { byWorkspace: next };
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * 특정 (workspaceId, tabId)의 StatusEntry를 반환한다.
 * 존재하지 않으면 undefined를 반환한다.
 */
export function selectStatusForTab(
  state: ClaudeStatusStore,
  workspaceId: string,
  tabId: string,
): StatusEntry | undefined {
  return state.byWorkspace[workspaceId]?.[tabId];
}

/**
 * 워크스페이스 내 모든 탭 상태를 집계해 최고 우선순위 상태와
 * 주의 필요 탭 수를 반환한다.
 *
 * 우선순위: permissionPending(4) > error(3) > needsInput(2) > running(1) > idle/없음(0)
 * count는 주의 필요(needsInput | permissionPending | error) 탭 수를 나타낸다.
 * 활성 탭이 없으면 null을 반환한다.
 *
 * 주의: 호출자가 shallow 비교로 결과를 메모이즈해야 연속 렌더에서 identity가 유지된다.
 */
export function selectWorkspaceAggregateStatus(
  state: ClaudeStatusStore,
  workspaceId: string,
): { status: ClaudeStatus; count: number } | null {
  const wsRecord = state.byWorkspace[workspaceId];
  if (!wsRecord) return null;

  const entries = Object.values(wsRecord);
  if (entries.length === 0) return null;

  let topPriority = -1;
  let topStatus: ClaudeStatus = "idle";
  let attentionCount = 0;

  for (const entry of entries) {
    const priority = STATUS_PRIORITY[entry.status];
    if (priority > topPriority) {
      topPriority = priority;
      topStatus = entry.status;
    }
    if (ATTENTION_STATUSES.includes(entry.status)) {
      attentionCount++;
    }
  }

  // 모든 탭이 idle이고 attention이 없는 경우도 결과를 반환한다.
  return { status: topStatus, count: attentionCount };
}

/**
 * 워크스페이스에 주의 필요 탭이 하나라도 있는지 반환한다.
 * (needsInput | permissionPending | error 탭이 존재하는 경우 true)
 */
export function selectIsWorkspaceAttention(
  state: ClaudeStatusStore,
  workspaceId: string,
): boolean {
  const aggregate = selectWorkspaceAggregateStatus(state, workspaceId);
  return aggregate !== null && ATTENTION_STATUSES.includes(aggregate.status);
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * 주어진 상태가 사용자 주의가 필요한 상태인지 반환한다.
 * needsInput | permissionPending | error 인 경우 true.
 */
export function isAttentionRequired(status: ClaudeStatus | undefined): boolean {
  return status !== undefined && ATTENTION_STATUSES.includes(status);
}
