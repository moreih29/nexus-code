# empirical-m3plus1-retrospective

M3+1 claude-code 어댑터 수직 통합 사이클에서 마주한 관찰과 교훈이다.

## 관찰

이번 사이클은 `harness/tab-badge` 1종만 계약으로 동결하고, claude-code 어댑터 1종이 sidecar → main → renderer → WorkspaceSidebar까지 도달하는 수직선을 만들었다. 나머지 observer event 4종은 의도적으로 뒤로 미뤘다. 이 절단선은 효과적이었다. schema, Go 수작업 contract, SidecarBridge, preload, renderer store, UI 뱃지를 한 번에 닫을 수 있었다.

Claude Code Hooks PoC에서는 `PreToolUse` 뒤 `PostToolUse`가 자동 승인에서도 1초 이상 늦게 도착할 수 있음을 확인했다. 따라서 200~500ms debounce만으로 승인 대기를 판정하면 자동 승인 실행을 잘못 `awaiting-approval`로 표시한다. 실제 승인 대기 신호는 `Notification.notification_type == "permission_prompt"`가 결정적이었다.

Unix socket hook 채널은 sidecar와 잘 맞았다. hook process는 짧게 실행되고 종료되므로 장기 WebSocket 연결보다 Unix socket 1회 write 모델이 단순했다. token 파일을 first line으로 검증하는 방식도 settings 파일에 secret을 직접 박지 않아 침범 범위가 좁다.

workspace-local `.claude/settings.local.json`만 편집하는 정책은 사용자 침범을 줄이는 데 중요했다. 전역 설정을 건드리지 않는 대신 워크스페이스별 `.gitignore`와 백업 정책이 필요해졌다. 이 경로는 기능보다 신뢰 문제에 가깝다.

SIGTERM close code 진단에서는 non-privileged tcpdump가 macOS BPF 권한으로 막혔지만, raw RFC6455 socket capture로 sidecar가 실제 application-wire close frame `1001 going away`를 송신함을 확인했다. 따라서 남은 의심 지점은 main 측 `ws` close event 관측 또는 합성 경로다.

## 교훈

첫 observer 표면은 작은 dot 하나였지만, 실제 완성 조건은 계약·sidecar listener·main bridge·preload·renderer store·접근성 텍스트·테스트까지 이어지는 긴 수직선이었다. UI가 작다고 통합 비용이 작지는 않다.

PoC를 첫 task로 배치한 것은 옳았다. `awaiting-approval` 판정이 debounce 기반으로 굳어졌다면 이후 adapter와 UI가 모두 잘못된 상태 모델을 내장했을 것이다. 외부 하네스의 hook semantics는 추정하지 말고 실제 인스턴스로 먼저 재야 한다.

plan task 수는 정직하게 분해해야 한다. 이 사이클도 10개 미만으로 압축하려 했다면 settings manager, hook listener, dist require guard, docs 정착 중 하나가 누락됐을 가능성이 높다. 수직 통합 사이클은 구현 task보다 검증·정착 task가 더 많이 보일 수 있다.

## 후속으로 남긴 것

- SidecarProcessRuntime 제거
- powerMonitor suspend/resume
- bootTime 기반 PID reaping
- respawn backoff와 UI degraded 상태
- opencode·codex 어댑터
- ToolCall, FileDiff, Notification, SessionHistory observer 표면
- SIGTERM close code 정확 fix
- workspace hook socket path 길이 단축 또는 hash root 정책
