# pattern-claude-code-adapter

claude-code를 nexus-code Harness Observer에 연결할 때 쓰는 재사용 패턴이다.

## 핵심 분리

claude-code 어댑터는 hook을 직접 받지 않는다. 수신은 sidecar가 담당하고, 어댑터는 sidecar observer stream을 소비한다.

역할은 다음처럼 나눈다.

1. workspace-local `.claude/settings.local.json`이 Claude Code Hooks command를 등록한다.
2. hook command는 같은 `nexus-sidecar` 바이너리의 `hook` subcommand를 호출한다.
3. hook subcommand는 워크스페이스별 Unix socket에 token line + JSON event line을 쓴다.
4. sidecar listener는 token과 workspaceId를 검증한다.
5. sidecar observer는 hook payload를 `harness/tab-badge`로 정규화해 WebSocket으로 main에 보낸다.
6. `ClaudeCodeAdapter`는 sidecar observer stream을 소비해 제품 코어의 `HarnessAdapter` 계약을 만족한다.
7. renderer는 IPC event를 Zustand store에 반영하고 WorkspaceSidebar dot을 갱신한다.

이 분리는 중요하다. settings 파일 편집, Unix socket, WebSocket, UI store가 한 클래스에 섞이면 외부 하네스 변경이 제품 코어까지 전파된다.

## 상태 매핑

4상태 계약은 유지한다.

| Claude Code hook | 조건 | TabBadgeState |
|---|---|---|
| `PreToolUse` | session id 존재 | `running` |
| `Notification` | `notification_type == "permission_prompt"` | `awaiting-approval` |
| `PostToolUse` | 정상 결과 | 미발화, latest session만 갱신 |
| `Stop` | 턴 종료 | `completed` |
| `StopFailure` 또는 error field | 오류 | `error` |

`awaiting-approval`은 debounce 단독으로 판정하지 않는다. 실측상 자동 승인 실행에서도 `PreToolUse` 뒤 `PostToolUse`가 1초 이상 늦을 수 있어 200~500ms timeout은 false positive를 만든다.

## last-event-wins

워크스페이스당 복수 claude-code 세션이 동시에 움직일 수 있다. 첫 표면은 세션별 뱃지가 아니라 워크스페이스 상태 뱃지 하나이므로 last-event-wins만 적용한다.

- timestamp가 최신인 event가 워크스페이스 뱃지를 지배한다.
- timestamp가 같으면 수신 순서가 최신이다.
- 더 오래된 session의 늦은 `Stop`은 최신 session의 `awaiting-approval`이나 `running`을 지우지 않는다.
- `completed`는 UI에서 무뱃지로 접는다.
- 다음 `PreToolUse`는 이전 `error`를 자동으로 `running`으로 바꾼다.

## settings 파일 정책

전역 `~/.claude/settings.json`은 수정하지 않는다. workspace-local `.claude/settings.local.json`만 편집한다. 우리 hook에는 `source: "nexus-code"` marker를 붙이고 unregister 시 marker hook만 제거한다. marker 없는 사용자·다른 도구 hook은 읽기 전용이다.

settings 수정 전 기존 파일이 있으면 한 번만 백업한다. `.claude/settings.local.json`은 `.gitignore`에 추가한다. 사용자는 이 파일 편집이 워크스페이스에 국한된다는 설명을 먼저 봐야 한다.

## 금지

- IDE가 승인 버튼을 대신 누르지 않는다.
- Claude Code TUI를 대체하지 않는다.
- settings 파일에 token 값을 직접 쓰지 않는다.
- `Notification` 전체를 승인 대기로 해석하지 않는다.
- debounce timeout만으로 승인 대기를 추론하지 않는다.
