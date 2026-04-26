# 하네스 어댑터 플러그인 경계

각 하네스 어댑터 구현은 이 디렉터리에 격리한다. claude-code를 기준 구현으로 두고, 다른 하네스는 같은 경계에 추가한다.

plugin boundary 원칙은 `.nexus/context/harness-integration.md`를 참조한다.

현재 구현:

- `claude-code/` — sidecar observer stream을 소비하는 읽기 전용 adapter. 첫 표면은 `harness/tab-badge` 워크스페이스 상태 뱃지다.

후속 구현:

- `opencode/`
- `codex/`
