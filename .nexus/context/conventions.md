## 코드 스타일
- broadcast 이벤트 상관관계 키는 transport requestId가 아니라 도메인 식별자(workspaceId/tabId/uri 등)를 사용한다.
- 폴더 구조는 사람이 인지하기 쉽도록 계층화함
- 클래스 및 함수에는 주석을 통해 의미를 반드시 작성 (단, M0, Phase1 같은 일시적인 내용은 담지 않음)

## 테스트 룰
- 라이브러리 / 타입 시스템 / 스키마가 이미 보장하는 동작은 다시 검증하지 않음 (zod 자체 검증, 타입 재진술, mock 인자 echo 류는 시나리오가 아님)
- 상위 시나리오 테스트가 이미 커버하는 부분집합은 별도 케이스로 두지 않음

## 에러 관리

### IPC 경계
- IPC 핸들러(main)는 throw하지 않는다. `ipcOk` / `ipcErr` (`src/shared/ipc/result.ts`)로 `IpcResult` 봉투를 반환한다.
- 렌더러는 `ipcCallResult` (`src/renderer/ipc/client.ts`)로 IPC를 호출해 `IpcResult`를 수신하고 `result.ok`로 성공·실패를 분기한다. throw가 필요한 경우에만 `unwrapIpcResult` / `mustSucceed`를 명시적으로 사용한다.
- git 채널은 `unwrapGitResult`를 통해 `git-error` 서브타입을 보존한다. 다른 채널에 git 전용 헬퍼를 적용하지 않는다.
- `validateArgs` 실패는 라우터가 `ipcErr("invalid-args", ...)` 봉투로 변환하며, 렌더러에서 `invalid-input` category로 매핑된다.

### AppError category
`src/shared/error/app-error.ts`의 닫힌 4값 union을 사용하며 임의 category를 추가하지 않는다.

| category | 의미 | UI 처리 |
|---|---|---|
| `invalid-input` | 호출자가 잘못된 인자를 전달함. 동일 인자로 재시도해도 실패 | inline 표시 |
| `cancelled` | 사용자 또는 신호에 의한 중단. 오류가 아님 | silent (표시 없음) |
| `failed` | 도메인 수준의 예상 가능한 실패 (미발견, 충돌 등). `code`로 회복 분기 가능 | inline 또는 banner |
| `bug` | 예상치 못한 불변 위반. 원인 불명이므로 로깅 필수 | toast 전용 |

`domain`(`git`·`fs`·`ssh`)과 `code`는 원본 taxonomy 값을 그대로 보존한다. UI 분기 로직이 이 값에 의존하므로 임의로 변환하지 않는다.

### 에러 표면화
- 렌더러에서 에러를 UI에 노출할 때는 반드시 `surfaceError` (`src/renderer/services/error-surface/surface-error.ts`) 하나만 사용한다.
- 한 에러에 `surfaceError`를 두 번 이상 호출하지 않는다 (한 호출 = 한 surface).
- category별 합법 surface:
  - `invalid-input` → `inline`만 허용 (toast / banner는 거부됨)
  - `cancelled` → 표시 없음 (silent)
  - `failed` → `inline` 또는 `banner` (onRetry 전달 가능), `toast` 또는 `auto`는 toast로 처리
  - `bug` → `toast`만 허용 (inline / banner는 거부됨)
- `internalMessage`(category·domain·code·message·correlationId 포함)는 로그에만 기록하고, `userMessage`(범주별 범용 문구)만 화면에 표시한다.

### UI 비동기 액션
- IPC를 호출하는 UI 액션은 `useIpcAction` (`src/renderer/hooks/use-ipc-action.ts`)으로 관리한다.
- 훅은 discriminated union 상태(`idle → loading → success | error`)를 제공하며, 액션이 어떤 경로로 종료되어도 `loading`이 고착되지 않음을 보장한다.
- 훅은 표시 중립(display-neutral)이다. `state.error`가 생겼을 때 `surfaceError`를 호출하는 것은 컴포넌트의 책임이며, 훅 내부에서 surface를 호출하지 않는다.
- 동일 액션의 중복 제출(double-submit)은 훅이 자동으로 방어한다.

### 부분 실패 정책
다단계 액션의 결과는 **주(primary) 효과의 성공 여부**로 판정한다.

- **주 효과** — 액션의 핵심 목적(예: 파일 저장). 실패 시 전체 실패로 처리한다.
- **부차(secondary) 효과** — 주 효과 이후의 보조 작업(예: 사후 알림, 통계 기록). 실패 시 비차단 경고로 격하하고 범위한정 재시도를 시도한다. 전체 롤백이나 차단을 하지 않는다.
- 본질적으로 atomic한 작업은 main에서 합성하여 최종 결과만 IPC 경계를 통과시킨다.

### 로깅
- 로그는 반드시 facade만 사용한다: main 프로세스는 `src/shared/log/main.ts`의 `createLogger(source)`, 렌더러는 `src/shared/log/renderer.ts`의 `createLogger(source)`. `console.log` / `console.error` 등 직접 호출 금지.
- `source`는 모듈 또는 서브시스템 식별자를 바인딩하고, 관련 로그를 연결할 때 `correlationId`를 `meta`로 전달한다.
- `internalMessage`는 로그에만 기록하고 화면에 노출하지 않는다.
- 전역 안전망(`src/main/error-safety-net.ts`, `src/renderer/services/window-error-handler.ts`, `src/renderer/components/ui/error-boundary.tsx`)은 놓친 에러의 최후 수단이다. 각 핸들러에서 이미 잡힌 에러를 다시 전역 안전망에 의존하지 않는다.
