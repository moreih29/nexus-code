# empirical-m3plus1-retrospective

claude-code 어댑터 수직 통합에서 얻은 반복 가능한 관찰과 교훈이다.

## 관찰

첫 observer 표면은 `harness/tab-badge` 하나였지만, 완성 조건은 schema, Go contract, sidecar listener, main bridge, preload, renderer store, UI 뱃지, 접근성 텍스트, 테스트까지 이어지는 전체 수직선이었다. UI가 작다고 통합 비용이 작지는 않다.

Claude Code Hooks PoC에서는 `PreToolUse` 뒤 `PostToolUse`가 자동 승인 상황에서도 늦게 도착할 수 있음을 확인했다. debounce만으로 승인 대기를 판정하면 자동 승인 실행을 잘못 `awaiting-approval`로 표시한다. 승인 대기 신호는 `Notification.notification_type == "permission_prompt"`를 기준으로 삼아야 한다.

Unix socket hook 채널은 짧게 실행되는 hook process와 잘 맞았다. 장기 WebSocket 연결보다 1회 write 모델이 단순했고, token 파일을 first line으로 검증하면 settings 파일에 secret을 직접 넣지 않아도 된다.

workspace-local `.claude/settings.local.json`만 편집하는 정책은 사용자 신뢰를 지키는 데 중요하다. 전역 설정을 건드리지 않는 대신 워크스페이스별 `.gitignore`와 백업 정책을 함께 설계해야 한다.

SIGTERM close code 진단에서는 raw RFC6455 socket capture가 sidecar의 server-originated close frame이 `1001 going away`임을 확인했다. 따라서 main 측 `ws` close event 관측 또는 합성 경로를 별도로 의심해야 한다.

## 교훈

- 외부 하네스 semantics는 추정하지 말고 실제 인스턴스로 먼저 재야 한다.
- 수직 통합 task는 구현보다 검증·정착 task가 더 많아질 수 있으므로, task 수를 인위적으로 줄이지 않는다.
- hook 기반 통합은 기능 구현뿐 아니라 사용자 설정 침범 범위와 복구 정책까지 acceptance에 포함해야 한다.
