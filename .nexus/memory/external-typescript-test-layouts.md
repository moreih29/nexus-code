# TypeScript 테스트 파일 배치 — 외부 저장소 분포

## 조사 시점

2026-04. plan #28(테스트 코드와 로직 코드 분리 정리) 진행 중 researcher가 GitHub 15개 인기 저장소를 직접 확인하여 분류한 결과를 정리한다.

## 핵심 결론

**TypeScript 프로젝트에 단일 대세 트렌드는 존재하지 않는다.** "co-location이 모던 표준"이라는 통념과 "분리가 모던 패턴"이라는 통념 모두 실증 데이터로 지지되지 않는다. 실제로는 두 다수파(C와 D)가 양립한다.

## 분류 카테고리

| 코드 | 패턴 | 설명 |
|---|---|---|
| A | Co-location 단독 | `foo.ts` + `foo.test.ts`가 같은 디렉터리에 평면 배치 |
| B | `__tests__/` 폴더 | 각 source 디렉터리 옆에 `__tests__/foo.test.ts` 서브폴더 |
| C | `test/` 또는 `tests/` 루트 mirror | source와 분리된 별도 트리에 mirror 구조 |
| D | 하이브리드 | unit은 co-location, integration·e2e는 별도 폴더 |

## 분포 (15개 저장소)

| 분류 | 빈도 | 대표 저장소 |
|---|---|---|
| C `test/` 루트 | 6 | Vitest, Drizzle ORM, Zod, Astro, ts-pattern, Bun |
| D 하이브리드 | 5 | tRPC, Next.js, Remix, Excalidraw, Cal.com |
| A Co-location 단독 | 3 | Tailwind CSS 등 소수 |
| B `__tests__/` | 2 | Vite, TanStack Query (Jest 잔존 패턴) |

C와 D가 합쳐 11/15로 절대다수. A는 소수파, B는 Jest 관습이 남은 잔존형이다.

## 공식 도구의 위치 정책

- **Vitest** — 위치를 규정하지 않는다. 기본 include 패턴은 `**/*.{test,spec}.?(c|m)[jt]s?(x)`로 위치 무관 glob. 공식 가이드(vitest.dev/guide/learn/writing-tests)에서 "no single right way"라 명시.
- **Bun test** — 위치를 규정하지 않는다. 작업 디렉터리 전체에서 `*.test.{js|ts|tsx|jsx}`, `*.spec.*`, `*_test.*`를 재귀 탐색.
- **Create React App → Vite 마이그레이션 가이드** — 테스트 위치 이동을 권장하지 않는다. 기존 `__tests__/` 구조도 Vitest가 그대로 인식.

## 직접 확인된 실제 경로 샘플

- Vitest: `test/browser/fixtures/aria-snapshot/basic.test.ts` (C)
- Vite: `packages/vite/src/node/__tests__/config.spec.ts` (B)
- Drizzle: `drizzle-orm/tests/relation.test.ts` (C)
- Tailwind: `packages/@tailwindcss-cli/src/commands/canonicalize/canonicalize.test.ts` (A)
- Next.js: `packages/next/src/client/components/is-next-router-error.test.ts` (co-location) + 루트 `test/`(e2e) (D)
- Remix: `packages/auth/src/lib/auth.test.ts` (co-location 다수) + `test/`(integration) (D)
- Cal.com: `packages/app-store/BookingPageTagManager.test.tsx`(293건) + `__tests__/route.test.ts`(88건) (D)

## 본 프로젝트(nexus-code)의 위치

D 하이브리드 변형. `packages/app`은 unit이 source 옆 `*.test.ts(x)` co-location이고, integration/system/packaging은 `packages/app/test/<category>/`로 분리. `packages/shared`는 unit만 co-location. Next.js·Remix·Cal.com과 같은 카테고리.

plan #28에서 **D 강화**(현행 유지 + tsconfig exclude 추가)로 결정되어 conventions.md에 명문화됨.

## 출처

- Vitest 저장소: https://github.com/vitest-dev/vitest
- Vitest defaults.ts: https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/defaults.ts
- Vitest 공식 가이드: https://main.vitest.dev/guide/learn/writing-tests
- Bun test 공식 문서: https://bun.sh/docs/cli/test
- 그 외 13개 저장소 GitHub 트리는 plan #28 issue 2 analysis 기록 참조

## 갱신 트리거

다음 중 하나가 발생하면 본 메모리를 재조사한다.

- Vitest 또는 Bun test가 위치 정책을 규정하기 시작했을 때
- 본 모노레포가 D 하이브리드를 떠나 다른 패턴으로 이동을 검토할 때
- Vite·Next.js·Remix 등 본 메모리에 인용된 메이저 프로젝트가 패턴을 바꿨을 때 (분기 1회 점검 권장)
