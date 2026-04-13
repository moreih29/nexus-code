# OpenCode Probe Notes

## 목적

`packages/shared/src/types/__tests__/opencode-host-stub.ts`의 `OpenCodeHostStub`은
`AgentHost` 인터페이스의 **두 번째 컨슈머 컴파일 probe**다.

- `ClaudeCodeHost`(packages/server)가 첫 번째 컨슈머
- `OpenCodeHostStub`이 두 번째 컨슈머로서, `AgentHost` contract가 단일 구현에 overfitting되지 않았는지 컴파일 타임에 검증

런타임 동작은 없음. TypeScript `implements AgentHost` 선언이 컴파일 통과하면 probe 목적 달성.

## 위치

```
packages/shared/src/types/__tests__/opencode-host-stub.ts
```

`__tests__/` 폴더에 고정 → 테스트 러너나 prod 빌드가 import하지 않음.
`shared` 패키지의 `tsconfig.json`이 `__tests__` 폴더를 exclude해야 dist에 포함되지 않음.

## Phase 3 재사용 방법

OpenCode CLI 통합(Phase 3 계획)에서:

1. 이 stub을 `packages/server/src/adapters/opencode/` 로 복사·이동
2. stub의 `throw new Error('Not implemented')` 메서드를 실제 OpenCode CLI 호출로 교체
3. `app.ts` composition root에서 `ClaudeCodeHost` ↔ `OpenCodeHostStub` 를 env 변수 또는 설정으로 스위칭

stub이 `AgentHost` interface를 완전히 구현하기 때문에 추가 타입 픽스 없이 바로 composition root에 주입 가능.

## 폐기 기준

- OpenCode 실제 어댑터(`OpenCodeHost`) 구현이 완료되어 `adapters/opencode/` 에 배치되면
- 이 stub은 삭제하거나 단위 테스트용 mock으로 역할 변경
- 삭제 전 `agent-host-event-shape.test.ts` 등 기존 테스트가 실제 어댑터로 교체됐는지 확인

## Contract-surface diff 규칙 (요약)

`AgentHost` 인터페이스(`agent-host.ts`) 또는 관련 Zod 스키마를 변경하는 PR은
이 stub도 함께 업데이트해야 함. 상세 규칙은 `CONTRIBUTING.md` 참조.
