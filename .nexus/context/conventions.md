# Conventions

## 테스트 위치 규약

테스트 파일은 아래 네 가지 유형별 위치 규칙을 따른다.

**단위 테스트**: 대상 소스 파일과 같은 디렉터리에 콜로케이션. 파일명은 `*.test.ts`.

예: `src/main/terminal-host.ts` ↔ `src/main/terminal-host.test.ts`

**통합·하네스 테스트**: `packages/app/test/<scope>/<name>.test.ts`. 현재 유효한 스코프는 `ime-checklist`, `runtime`.

**계약 테스트**: 생산자 패키지 쪽 콜로케이션. 경로는 `packages/shared/src/contracts/*.test.ts`.

**Go sidecar 테스트**: 표준 `*_test.go` 콜로케이션. Go 관행을 그대로 따른다.

## 테스트 산출물 규약

테스트 실행 중 생성되는 산출물(스크린샷, 로그, 바이너리 출력 등)은 `packages/app/test/**/artifacts/` 경로로 통일한다. 이 경로는 커밋 금지 대상이다.

`.gitignore`는 저장소 루트 한 곳에서만 관리한다. 패키지·디렉터리별 로컬 `.gitignore` 조각 생성을 금지한다.

릴리스 증거는 별도 경로에 보관한다.

- 저장 경로: `release-evidence/<phase>/<ISO8601-KST>_<task|scope>/`
- 예: `release-evidence/phase-a/2026-04-24T15-12-00KST_task11/`
- 한번 기록된 증거는 수정·삭제·이동 금지. 정정이 필요하면 새 타임스탬프 디렉터리를 생성한다.

체크리스트·템플릿(`*.template.md`, `*.template.csv`) 및 README는 화이트리스트로 커밋 대상에 포함한다.

## 테스트 실행 명령

```sh
# shared 패키지 단위 테스트
cd packages/shared && bun test

# app 전체 테스트 (단위 + 통합)
cd packages/app && bun run test

# app 단위 테스트만
cd packages/app && bun run test:unit

# app 통합·하네스 테스트만
cd packages/app && bun run test:integration

# Go sidecar 테스트
cd sidecar && go test ./...
```

## 테스트 러너

JS/TS 테스트 러너는 Bun의 `bun test`로 고정한다. Vitest·Jest 도입을 금지한다(스택 핀 정책, `stack.md` 참조).

Go 테스트 러너는 표준 `go test`를 사용한다.

## 하네스 정책

Electron main·preload·renderer 3축은 `deterministic-seam` 하네스로 격리하여 테스트한다. 실제 Electron 런타임 검증은 `bun run verify:native`, `bun run smoke:*` 스크립트로 수행한다. 이 두 경계는 명확히 분리한다 — 하네스 테스트가 실제 런타임 실행을 대체하지 않는다.

## 기타 규약

커밋 메시지·브랜치 네이밍·PR 규칙은 TBD(별도 결정 사이클). 결정 전까지는 일반적인 관행을 따른다.
