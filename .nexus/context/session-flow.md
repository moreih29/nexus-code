# Session Flow

Nexus Code의 핵심 동작은 "사용자의 프롬프트가 Claude Code CLI로 흘러가 결과가 실시간으로 UI에 반영되는 것"이다. 이 흐름은 세션 생명주기, 이벤트 스트리밍, 권한 제어 세 축으로 구성된다.

## 세션 생명주기

```
[new] → [active] → [turn_end] → [active] → ... → [closed | error]
  ↑         ↓
  └────[restored from DB]
```

1. **생성/복원**: 사용자가 워크스페이스를 열면, 서버는 DB에서 기존 세션(`restorableSessionId`)을 조회한다. 존재하면 CLI 히스토리를 파싱해 메시지/탭/서브에이전트 상태를 복원하고, 없으면 새 세션을 생성한다.
2. **실행**: `SessionLifecycleService`가 `ProcessSupervisor`에 CLI 프로세스 생성을 요청한다. 프로세스는 워크스페이스 디렉토리에서 스폰되며, 설정(모델, 노력 수준, 권한 모드 등)은 `SettingsStore`에서 읽어 CLI 실행 시점에 반영된다.
3. **이벤트 수신**: CLI가 출력을 stdout으로 흘리면 `ProcessSupervisor`가 파싱해 도메인 이벤트(SessionEvent)로 변환하고 `EventEmitter`에 게시한다.
4. **스트리밍**: 각 워크스페이스는 SSE 채널(`/api/workspaces/{path}/events`)을 갖는다. EventEmitter 구독자가 SSE 클라이언트에게 이벤트를 푸시한다.
5. **종료**: 턴이 끝나면 `turn_end` 이벤트를, 세션이 닫히면 `session_closed`를, 오류가 발생하면 `session_error`를 발행한다.

## 이벤트 종류

SSE로 전달되는 주요 이벤트(모두 `@nexus/shared`의 `SessionEvent` Zod 스키마로 정의):

| 이벤트 | 의미 |
|--------|------|
| `session_init` | 세션이 활성화되고 메타데이터가 준비됨 |
| `text_delta` / `text_chunk` | 모델 응답 토큰 스트림 |
| `tool_call` | 모델이 도구 호출 요청 |
| `tool_result` | 도구 실행 결과 수신 |
| `permission_request` | 사전 승인이 필요한 위험 도구 |
| `permission_settled` | 승인/거부 결정 완료 |
| `turn_end` | 한 턴의 모든 출력이 끝남 |
| `session_error` | 예외 상태 |

웹 클라이언트는 이 이벤트 스트림을 Zustand 스토어(`chat-store`)에 투영하여 UI를 갱신한다.

## 권한 제어 아키텍처

Claude Code CLI는 도구 실행 전 Pre-tool-use hook을 호출할 수 있다. Nexus Code는 이 훅을 서버의 `/hooks/pre-tool-use` 엔드포인트로 라우팅해 **사전 승인 정책 레이어**를 구현한다.

### 평가 흐름

```
CLI ──[pre-tool-use]──▶ Server(/hooks/pre-tool-use)
                           │
                           ▼
                      ApprovalBridge
                      ├─ approval-policy-store (워크스페이스 정책)
                      └─ settings-store (permissionMode, disallowedTools)
                           │
                      ┌────┴────┐
                      ▼         ▼
                   [allow]   [deny | ask]
                      │         │
                      ▼         ▼
                  CLI 실행   permission_request SSE → 사용자 UI
                                 │
                                 ▼
                             사용자 응답 (Approval)
                                 │
                                 ▼
                         permission_settled SSE → CLI 재개
```

### 핵심 규칙

1. **ApprovalBridge가 정책 평가의 단일 진입점**. 정책 스토어와 설정 스토어를 조합해 최종 결정을 내린다.
2. **승인 요청은 SSE로 푸시**, 사용자 응답은 별도 REST(`/api/workspaces/{path}/approval`)로 수집한다. 응답이 오면 `permission_settled` 이벤트로 CLI를 재개시킨다.
3. **tool_result 파싱**은 CLI가 도구를 실제로 실행한 뒤 반환하는 결과를 `ProcessSupervisor`가 해석해 `tool_result` 이벤트를 발행하는 흐름이다. 이 경로가 끊기면 UI에서 도구 결과가 누락된다.
4. **권한 훅 수정 시 반드시 확인할 것**:
   - 훅이 각 세션 재시작에도 재주입되는가
   - 승인 요청이 SSE로 클라이언트까지 도달하는가
   - 도구 결과 파싱이 여전히 정상인가
   - 설정 변경이 런타임 평가에 즉시 반영되는가

## 설정 동기화

`SettingsStore`(DB)는 UI가 편집하는 설정의 원본이다. 변경은 `PUT /api/workspaces/{path}/settings`로 저장되고, 활성 세션에는 다음 CLI 실행 시점에 반영된다. 즉시 반영이 필요한 설정(예: permissionMode)은 `ApprovalBridge`가 매 훅 호출 시 최신 값을 읽어오므로 별도 동기화 없이 반영된다.

- **CLI_SETTINGS_KEYS**: UI 전용 필드(theme)를 제외한 9개 키만 CLI에 전달된다.
- **session-scoped vs workspace-scoped**: permissionMode는 세션 단위, 나머지 설정은 워크스페이스 단위로 관리한다.

## 복원 / 재개 경로

브라우저 리로드나 전체 재시작 후에도 세션이 이어지게 하는 것은 두 요소의 결합이다:

1. **DB에 저장된 세션 메타데이터**: `SessionStore`에 sessionId, 메시지, 활성 탭, 서브에이전트 정보 등이 영속화된다.
2. **CLI 히스토리 파일**: Claude Code CLI 자체가 디스크에 남기는 히스토리를 `SessionAdapter`가 파싱해 누락된 메시지를 재구성한다.

두 소스의 합집합이 Zustand 스토어로 투영되면 UI가 "중단 없이 이어지는 것처럼" 보인다. 실패 모드를 디버깅할 때는 이 두 소스 중 어느 쪽이 결손인지 먼저 확인해야 한다.
