<!-- PROJECT:START -->
# Nexus Code

Claude Code CLI를 로컬 데스크톱 GUI로 오케스트레이션하는 워크스테이션.
워크스페이스 관리, 실시간 세션 스트리밍, 권한 제어로 CLI를 안전하게 다룬다.

## Essentials

- **패키지 매니저**: Bun 전용 (`bun install`, `dev`, `build`, `typecheck`, `test:e2e`). npm/yarn 금지
- **Monorepo**: `packages/{shared,server,web,electron}` — 빌드 순서 `shared → server/web → electron`
- **3계층 통신**: web ↔ server는 HTTP/SSE, CLI → server는 Pre-tool-use hook (권한 제어)
- **타입 계약**: `@nexus/shared`의 Zod 스키마가 유일한 SoT (Workspace/Session/Approval/Event)
- **코드 스타일**: TypeScript strict, kebab-case 파일명, 한글 UI, 다크 테마 고정
- **권한 제어**: 훅/승인 정책 수정 시 재주입·SSE push·tool_result 파싱 모두 검증
- **테스트**: Vitest (unit), Playwright (`bun run test:e2e`, 빌드 선행 필요)
<!-- PROJECT:END -->
