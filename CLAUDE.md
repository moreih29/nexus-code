<!-- PROJECT:START -->
# Nexus Code

에이전트 감독자를 위한 통합 워크벤치. Claude Code(현재)·OpenCode(계획) 세션을
외부에서 spawn·관찰하고, 권한 요청은 Policy Enforcement Point가 중재한다.

**Non-goals**: 팀 기능 · 플러그인 편집(MCP·훅·스킬) · IDE 풀기능 · CC override는 범위 밖.
상세는 `.nexus/context/philosophy.md` 참조.

## Essentials

- **패키지 매니저**: Bun 전용 (`bun install`, `dev`, `build`, `typecheck`, `test:e2e`). npm/yarn 금지
- **Monorepo**: `packages/{shared,server,web,electron}` + `@moreih29/nexus-core` (read-only consumer) — 빌드 순서 `shared → server/web → electron`
- **3계층 통신**: web ↔ server는 HTTP/SSE, CLI → server는 Pre-tool-use hook (권한 제어)
- **타입 계약**: `@nexus/shared`의 Zod 스키마가 유일한 SoT (Workspace/Session/Approval/Event)
- **코드 스타일**: TypeScript strict, kebab-case 파일명, 한글 UI, 다크 테마 고정
- **권한 제어**: 훅/승인 정책 수정 시 재주입·SSE push·tool_result 파싱 모두 검증
- **테스트**: Vitest (unit), Playwright (`bun run test:e2e`, 빌드 선행 필요)
<!-- PROJECT:END -->
