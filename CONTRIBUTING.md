# Contributing to Nexus Code

## Contract-Surface Diff Rule

### AgentHost 인터페이스 변경 시 필수 체크리스트

`packages/shared/src/types/agent-host.ts` 또는 관련 Zod 스키마
(`AgentHostConfig`, `AgentHostEvent` 등)를 수정하는 PR은
**반드시** 아래 파일도 함께 업데이트해야 한다:

| 파일 | 역할 | 업데이트 이유 |
|------|------|--------------|
| `packages/shared/src/types/__tests__/opencode-host-stub.ts` | AgentHost 두 번째 컨슈머 컴파일 probe | interface 변경 시 stub도 implements해야 컴파일 통과 |

**방법**: `OpenCodeHostStub` 클래스에 새 메서드/변경된 시그니처를 반영하고,
`throw new Error('Not implemented')`로 구현체를 채운다.

이 규칙을 지키지 않으면 `bun run --filter '@nexus/shared' build` 또는 typecheck가 실패한다.

### PR 체크리스트

`agent-host.ts` 또는 Zod 스키마를 수정하는 PR은 아래 항목을 확인하라:

- [ ] `OpenCodeHostStub`이 변경된 `AgentHost` interface를 모두 구현하는가?
- [ ] `packages/shared`의 `bun run build`가 0 error로 통과하는가?
- [ ] `packages/server`의 `bun run typecheck`가 0 error로 통과하는가?

## Adapter Import Boundaries

`routes/`, `services/`, `domain/`은 `adapters/claude-code/**`를 직접 import해서는 안 된다.

- ESLint `no-restricted-imports` 규칙이 `packages/server/eslint.config.js`에 설정됨
- Vitest leak canary `packages/server/src/__tests__/import-boundaries.test.ts`가 위반을 감지함

ClaudeCode 어댑터 타입이 필요한 경우, `ports/` 추상화를 경유하거나
composition root(`app.ts`)에서 주입받는 방식으로 해결한다.

## 패키지 매니저

Bun 전용. `bun install`, `bun run build`, `bun run typecheck`, `bun test` 사용.
npm/yarn/pnpm 사용 금지.
