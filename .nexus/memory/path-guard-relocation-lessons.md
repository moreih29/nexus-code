# path-guard 재배치 교훈 (cycle #64 · 2026-04-10)

`fix/path-guard-relocation` 사이클에서 얻은 재사용 가능한 교훈 3가지.

## 1. barrel export 제거 시 전수 조사 필수

패키지의 barrel(`index.ts`)에서 심볼을 제거할 때는 해당 심볼을 import하는 **모든 소비자**를 전수 조사해야 한다. "단일 호출부"라는 인상적인 가정은 쉽게 틀린다.

**이번 사이클 실사례**: `@nexus/shared` 의 path-guard 심볼 사용처를 조사하면서 `packages/server/src/adapters/hooks/path-guard-preflight.ts` 한 곳으로 결론냈으나, 실제로는 `packages/server/src/adapters/db/approval-policy-store.ts:3`도 `PROTECTED_DIRS` 를 import하고 있었다. 초기 Grep 결과에 그 파일이 이미 등장했는데 "path-guard 관련 파일이 아닌 것으로 보여서" 제외했다 — 실제로는 path-guard 상수를 소비 중이었다. Phase 2 수정에서 누락 → Phase 3 server 빌드(T10)에서 TS2305로 드러남 → hotfix.

**재발 방지 체크리스트**:
1. 먼저 `grep '@nexus/<pkg>' packages/<consumer>/src` 로 모든 import를 나열
2. 제거 대상 심볼 각각에 대해 **심볼 이름만**으로 별도 grep (`PROTECTED_DIRS`, `extractPaths` 등) — import 구문뿐 아니라 사용부까지
3. 코드 파일과 테스트 파일 모두 검색 (테스트의 fixture/describe 문자열 내 언급과 실제 import는 구분)
4. 로컬 변수 동명 케이스 경계 — 예: `permission-block.tsx` 의 `const isProtected = ...` 는 shared의 `isProtected` 와 이름만 같고 무관

## 2. 빌드 스크립트는 반드시 clean step 포함

`"build": "tsc"` 만 쓰면 TypeScript는 기존 `dist` 파일을 삭제하지 않으므로, 소스에서 파일이 이동/삭제되면 **stale artifact**가 dist에 남는다. 이 상태에서 "dist 구조 검증" 같은 빌드 acceptance 를 돌리면 false failure가 발생하고, 최악의 경우 구 산출물이 런타임에 import되어 동작 불일치가 난다.

**이번 사이클 실사례**: T9 에서 `packages/shared/dist/__tests__/` 에 이전 빌드의 path-guard.test.d.ts/js 12개 파일이 stale로 남아 있었다. `bun run clean && bun run build` 로만 해결 가능.

**해법 (T15 hotfix로 적용)**: `packages/{shared,server,electron}/package.json` 의 build 스크립트를 다음 형태로 통일.
```json
"build": "rm -rf dist && tsc"
```
`clean` 스크립트는 그대로 유지(독립 호출 용도). web 은 Vite 가 매 빌드마다 clean 하므로 예외.

## 3. shared 는 Node I/O 모듈을 받지 않는다

`.nexus/context/architecture.md` 의 shared 정의는 "Zod 스키마 타입 계약 + Result 모나드". Node 런타임 의존(`fs`, `os`, `path` 등)을 포함하는 모듈이 shared에 들어오면 두 가지 실질 문제가 생긴다.

1. web 번들러(Vite)가 shared barrel 을 트리셰이킹할 때 Node 빌트인 모듈이 번들 그래프에 포함될 수 있음 (side-effect free 보장 불가)
2. shared `package.json` 이 `@types/node` 를 요구하게 되어 "타입 계약" 원칙이 `package.json` 에 박혀 공식화됨

**원칙**: 호출부가 한 패키지(server 등)뿐이고 Node I/O 를 쓰는 모듈은 해당 소비자 패키지에 둔다. "언젠가 다른 패키지가 쓸지 모른다" 는 YAGNI 위반 — 재사용 필요가 실제로 발생하면 역방향 승격(소비자 → shared)은 쉽고 싸다. path-guard 는 이 원칙의 반례였고 이번 cycle에서 복구됐다.

**판정 기준 (새 모듈을 shared 에 둘지 결정할 때)**:
- Node 빌트인(`node:fs` 등) 사용? → shared **금지**
- 호출부가 2+ 패키지? → shared 후보
- 호출부가 1 패키지? → 해당 패키지에 배치
- 순수 타입/Zod 스키마/상수? → shared 허용

## 4. dev 세션 정리는 PID가 아닌 port listener 기준으로

`bun run dev` 등 dev orchestrator의 자식을 종료할 때 **부모 PID kill만으로는 자식이 함께 죽지 않는다**. `tsx --watch` 같은 Node `--watch` 계열은 자식을 별도 PID로 분리 spawn하므로 부모가 SIGTERM을 받아도 자식은 orphan화(`ppid=1`)되어 port를 계속 점유한다.

**실사례**: cycle #64 dev smoke test 준비 중 cwd 를 `packages/server` 로 둔 채 `bun run dev` 를 background로 띄워 server 단독 dev(`tsx --watch src/index.ts`)가 실제 node server를 PID 46597로 spawn 했다. 부모 shell만 `kill -TERM` 했을 때 tsx wrapper는 죽었지만 **PID 46597이 `ppid=1` 로 재부모화되어 살아남아 cycle #64/#65 두 사이클이 모두 끝난 뒤까지 1시간 22분 동안 port 3000을 점유**. cycle #64 T14 에서 이 현상을 "사용자 기존 dev 세션" 탓으로 오진해 electron 프로세스만 정리하고 server orphan 을 놓친 게 직접 원인.

### 체크리스트 — dev 세션 정리

1. **port listener 우선 정리**: PID tree 를 쫓지 말고 실제 listener 부터. PID tree 탐색보다 빠르고 정확.
   ```bash
   lsof -nP -iTCP:3000 -sTCP:LISTEN   # @nexus/server (Hono)
   lsof -nP -iTCP:5173 -sTCP:LISTEN   # @nexus/web (Vite)
   ```
   결과에 나온 PID 를 직접 `kill -TERM`.
2. **tree kill 이 필요하면** `pkill -TERM -P <parent_pid>` (부모의 자식을 재귀 종료) 또는 `kill -- -<PGID>` (process group leader 기준).
3. **orphan 감지**: `ps -p <pid> -o ppid=` 결과가 `1` 이면 재부모화된 잔존물. `nexus-code` 관련 프로세스 중 `ppid=1` 인 건 모두 정리 대상.
4. **cwd 실수 방지**: background로 `bun run dev` 를 띄우기 전 `pwd` 로 root 확인. `bun run --filter '*' ...` 형식은 cwd 무관하므로 더 안전.

### 재발 방지 원칙

- 긴 실행(watch/서버) 프로세스를 background로 띄웠다면 작업 완료 전 **반드시 PID 와 port listener 둘 다로** 정리 확인.
- dev orchestrator를 종료할 때 단순 `kill <parent>` 로 끝내지 말고 port listener가 해제됐는지 `lsof` 로 실증.
