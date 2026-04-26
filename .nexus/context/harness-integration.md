# Harness Integration

## A2 통합 모델 원칙

nexus-code는 AI 하네스를 **터미널 + 이벤트 Observer** 방식으로 통합한다.

IDE는 하네스의 실행 흐름을 읽기 전용으로 관찰하며, 관찰 결과를 부가 UI로 제공한다.
TUI를 대체하거나 하네스 내부 상태에 개입하지 않는다.

핵심 원칙 두 가지:

- **TUI 대체 금지**: 하네스가 터미널에서 제공하는 TUI 인터페이스를 교체하거나 감싸지 않는다. 터미널은 하네스가 소유하며, IDE는 그 옆에서 관찰한다.
- **IDE는 읽기 전용 관찰자**: IDE가 제공하는 모든 하네스 관련 UI는 관찰 결과를 표시하는 데 그친다. 하네스에 상태를 주입하거나 제어 신호를 보내지 않는다.

---

## IDE가 제공하는 관찰 기능 5종

A2 모델에서 IDE는 다음 5가지 관찰 기능을 제공한다.

1. **워크스페이스 상태 뱃지**: WorkspaceSidebar에 하네스 상태를 표시한다. 표시 상태는 도구 실행중 / 승인 대기 / 완료 / 에러 네 가지다.
2. **사이드 패널의 최근 tool 호출**: 하네스가 호출한 도구 목록을 사이드 패널에 순서대로 표시한다.
3. **파일 편집 diff 뷰**: 하네스가 파일을 편집한 사실이 감지되면 에디터에 diff 뷰를 표시한다.
4. **완료·승인 대기 OS 알림**: 턴 완료 또는 승인 대기 상태가 되면 OS 알림을 발송한다.
5. **세션 히스토리 읽기 전용 열람**: 세션 파일에 기록된 대화 히스토리를 읽기 전용으로 열람할 수 있다.

---

## HarnessAdapter 인터페이스 계약

`HarnessAdapter` 인터페이스: `packages/shared/src/harness/HarnessAdapter.ts`. plugin boundary: `packages/shared/src/harness/adapters/<name>/`. claude-code 1종은 `packages/shared/src/harness/adapters/claude-code/`에 구현되어 있으며, opencode와 codex는 같은 경계 안에서 후속 구현한다.

`HarnessAdapter`는 제품 코어에 고정된 단일 인터페이스다. 각 하네스별 구현은 이 인터페이스를 충족하는 플러그인 레이어로 격리된다.

계약의 핵심 조건:

- **읽기 전용 observer**: 어댑터는 하네스 상태를 읽을 수 있지만 주입하거나 변경할 수 없다.
- **이벤트 수신 수단**: hooks API(PreToolUse / PostToolUse / Notification / Stop 등) 또는 세션 파일 tail 방식으로 이벤트를 수신한다. 두 수단은 하네스별로 선택하며, 공식 지원 경로만 사용한다.
- **상태 주입 금지**: 어댑터가 하네스의 내부 상태, 설정, 컨텍스트에 값을 쓰는 행위는 인터페이스 계약 위반이다.

하네스별 관찰 메커니즘:

| 하네스 | 관찰 경로 |
|---|---|
| claude-code | Hooks API 기반 워크스페이스 상태 뱃지. 세션 파일 `.jsonl` tail은 세션 히스토리 표면 도입 시 합류 |
| opencode | SQLite 세션 DB + 이벤트 스트림 |
| codex | 세션 파일 / JSON 출력 (스키마 변동 많음 — 어댑터 지속 보수 필요) |

claude-code Hooks 이벤트는 workspace-local `.claude/settings.local.json` 등록으로 수신한다. 전역 `~/.claude/settings.json`은 수정하지 않는다. hook command는 같은 `nexus-sidecar` 바이너리의 `hook` subcommand로 Unix socket에 이벤트를 전달하고, sidecar는 이를 `harness/tab-badge` observer event로 정규화한다.

워크스페이스 상태 뱃지는 `running`, `awaiting-approval`, `completed`, `error` 네 상태를 계약으로 갖는다. UI 표면에서는 `completed`를 무뱃지로 접어 "끝났다=조용해졌다" 모델을 따른다. `awaiting-approval`은 Claude Code `Notification.notification_type == "permission_prompt"`일 때만 발화하며, 시간 debounce 단독 추론은 금지한다.

---

## per-turn spawn + `--resume` 원칙

하네스 프로세스 실행은 **per-turn spawn + `--resume <sessionId>`** 패턴만 허용한다.

- 각 턴마다 하네스 프로세스를 새로 생성(spawn)하고, 이전 세션은 `--resume <sessionId>` 인자로 이어붙인다.
- 세션 연속성은 세션 파일 기반으로 보장된다. 프로세스가 종료되어도 대화 히스토리는 보존된다.
- **비공식 stream-json 다중 턴 경로 사용 금지**: 공개된 공식 인터페이스가 아닌 내부 stream-json 포맷을 이용한 다중 턴 구현은 허용하지 않는다. 이전 프로젝트 폐기의 직접 원인이었으며, 외부 프로토콜 변경 시 즉각 붕괴한다.

---

## 명시적 금지 사항

다음 기능은 제품 범위에서 제외한다.

- **자체 AI 추론 엔진**: nexus-code는 AI 추론을 직접 수행하지 않는다.
- **에이전트 비교·오케스트레이션**: 복수의 AI 에이전트를 한 화면에서 비교하거나 조율하는 전용 UX를 만들지 않는다.
- **TUI 대체 chat UI**: 하네스의 터미널 기반 대화 인터페이스를 IDE 내 별도 채팅 UI로 교체하지 않는다.

---

## 플러그인 경계 원칙

`HarnessAdapter` 인터페이스는 제품 코어에 속한다. 각 하네스 구현 코드는 코어 외부 플러그인 레이어에 격리된다.

이 경계가 의미하는 바:

- 외부 하네스의 프로토콜, API, 파일 포맷이 바뀌어도 제품 코어와 정체성은 영향받지 않는다.
- 어댑터 수정 범위는 해당 플러그인 레이어 내부로 제한된다.
- 특정 하네스 어댑터가 유지 불가 상태가 되어도 나머지 제품의 동작은 유지된다.

이 원칙은 이전 Tauri 기반 프로젝트 폐기 교훈에서 비롯된다. 외부 API 변경 하나가 제품 전체를 무너뜨린 경험을 반복하지 않기 위한 구조적 방어다.
