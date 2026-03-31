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
- Context Provider의 value에 null이 가능한 경우, 소비자 컴포넌트의 null-guard + 렌더 트리 경로 검증 필수

## 구현 원칙
- 느리더라도 안정적인 구현 우선
- 확실하게 확인하고 수정한 뒤 QA
