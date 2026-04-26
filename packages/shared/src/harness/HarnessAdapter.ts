import type { WorkspaceId } from "../contracts/workspace";
import type {
  TabBadgeEvent as GeneratedTabBadgeEvent,
  TabBadgeState as GeneratedTabBadgeState,
} from "../contracts/harness-observer";

export type ObservationPath =
  | "hooks-api"
  | "session-file-tail"
  | "sqlite-db"
  | "json-output"
  | "mixed";

export interface AdapterMetadata {
  name: string;
  version: string;
  observationPath: ObservationPath;
}

export type TabBadgeState = GeneratedTabBadgeState;

export interface ObserverEventBase {
  workspaceId: WorkspaceId;
  timestamp: string;
}

export type TabBadgeEvent = GeneratedTabBadgeEvent;

export interface ToolCallEvent extends ObserverEventBase {
  type: "harness/tool-call";
  // TODO(plan #16+): tool 이름, 입력 요약, 결과 상태 필드를 정의한다.
}

export interface FileDiffEvent extends ObserverEventBase {
  type: "harness/file-diff";
  // TODO(plan #16+): 파일 경로와 diff 원천 식별 필드를 정의한다.
}

export interface NotificationEvent extends ObserverEventBase {
  type: "harness/notification";
  // TODO(plan #16+): 턴 완료와 승인 대기 알림 세부 필드를 정의한다.
}

export interface SessionHistoryEvent extends ObserverEventBase {
  type: "harness/session-history";
  // TODO(plan #16+): 세션 항목 식별자와 읽기 전용 표시 필드를 정의한다.
}

export type ObserverEvent =
  | TabBadgeEvent
  | ToolCallEvent
  | FileDiffEvent
  | NotificationEvent
  | SessionHistoryEvent;

/**
 * READ-ONLY OBSERVER.
 *
 * HarnessAdapter는 하네스 실행 흐름을 읽기 전용으로 관찰하는 제품 코어 계약이다.
 * 구현체는 이벤트를 수집해 UI 관찰 모델에 전달할 수 있지만, 하네스 상태를 변경하거나
 * 주입하거나 쓰는 메서드를 제공하지 않는다.
 */
export interface HarnessAdapter {
  describe(): AdapterMetadata;
  observe(workspaceId: WorkspaceId): AsyncIterable<ObserverEvent>;
  dispose(): Promise<void> | void;
}
