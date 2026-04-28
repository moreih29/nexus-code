# Conventions

프로젝트 차원 규약은 합의 시점에 이 문서에 추가한다. 합의 전까지는 일반적인 관행을 따른다.

## 테스트 배치

테스트 배치의 기본 목표는 읽기 쉬운 근접성과 빌드·번들 위생을 함께 지키는 것이다.

### TypeScript

- 소스 단위 테스트는 대상 소스 파일과 같은 영역에 둔다.
- `__tests__/` 폴더는 만들지 않는다.
- 새 테스트 파일명은 `*.test.ts` 또는 `*.test.tsx`를 사용한다. `*.spec.ts`와 `*.spec.tsx`는 사용하지 않는다.
- 통합·시스템·패키징 범주의 테스트는 기존처럼 `packages/app/test/integration/`, `packages/app/test/system/`, `packages/app/test/packaging/`에 둔다.

### Go

- Go 테스트는 대상 파일과 같은 디렉터리에 `*_test.go`로 둔다.
- 외부 관점에서 공개 API를 검증해야 할 때는 같은 디렉터리에서 `package <name>_test`를 사용할 수 있다.
- 별도 `tests/` 디렉터리는 만들지 않는다.

## 미정

- 커밋 메시지 형식
- 브랜치 네이밍
- PR 리뷰 규칙
