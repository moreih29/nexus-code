<!-- tags: rules, git, qa, workflow, team -->
# 개발 규칙

## Git / 배포
- 커밋/푸시는 사용자 명시적 지시 시에만 실행
- 브랜치: `feat/{scope}`, `fix/{scope}`, `chore/{scope}`
- 커밋 형식: `{type}: {scope} — {description}`

## QA / 검증
- 구현 후 반드시 QA 검증 진행
- `bun run typecheck` 통과 확인
- `bun run dev` 실행하여 런타임 동작 확인
- **런타임 스크린샷 검증**: QA 시 `bun run dev`로 앱 실행 후, localhost URL에 Playwright MCP로 접근하여 스크린샷을 촬영하고 정상 렌더링 여부를 확인한다. cold-start(초기 상태), 워크스페이스 선택 후 등 주요 시나리오 포함. (electronAPI는 없지만 레이아웃/렌더링 검증에 충분)
- Context Provider의 value에 null이 가능한 경우, 소비자 컴포넌트의 null-guard + 렌더 트리 경로 검증 필수

## 구현 원칙
- 느리더라도 안정적인 구현 우선
- 확실하게 확인하고 수정한 뒤 QA