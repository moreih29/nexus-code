# pattern: ipcStream 선택 가이드

## 목적

요청자가 시작하고 진행률과 완료값을 함께 받아야 하는 작업은 `ipcStream`으로 구현한다. 도메인 payload에는 transport 상관관계 키(`requestId`, `streamId`)를 넣지 않는다.

## 선택 기준

| 상황 | 사용할 IPC 모델 | 이유 |
|---|---|---|
| Renderer가 시작하고 일이 끝나면 종료되는 unit-of-work | `ipcStream` | 시작·progress·complete·abort lifecycle이 한 요청에 묶임 |
| 파일 watcher, PTY, LSP diagnostics처럼 외부 소스가 push하는 long-lived 이벤트 | `listen`/`broadcast` subscription | caller request와 lifecycle이 다르고 여러 renderer가 구독 가능 |
| Main이 renderer에 묻고 renderer 응답이 필요한 역방향 요청 | inverted request 패턴 | 요청 방향이 반대라 streamId 발급 권위가 맞지 않음 |

## ipcStream 표준

- Main router가 `streamId`를 단독 발급한다. Renderer나 도메인 handler가 생성하지 않는다.
- Renderer는 `ipcStream(channel, method, args, { signal })`을 호출하고 `{ promise, onProgress }`를 받는다.
- Main handler는 `async function*` 형태로 작성한다.
  - `yield` = progress payload
  - `return` = complete payload
  - `throw` = error event / promise rejection
- Router가 args/progress/complete zod 검증, sender-targeted send, abort cleanup을 맡는다.
- Progress schema는 도메인 데이터만 담는다. 예: search는 `FileMatch[]` batch 자체를 progress로 보낸다.
- `onProgress`는 `promise`를 await 하기 전에 등록한다. 먼저 도착한 progress는 replay되지 않는다.

## Abort 규칙

- Renderer abort는 `window.ipc.cancel(streamId)`로 router에 전달한다.
- Router는 `AbortController`를 abort하고 generator `return()`을 호출해 cleanup을 유도한다.
- Domain walker/worker는 abort를 partial complete로 바꾸지 않는다. abort는 `AbortError`로 throw되어야 한다.
- UI store는 필요하면 이미 받은 partial progress를 유지하고 status만 idle로 바꾼다.

## 구현 체크리스트

1. `src/shared/ipc-contract.ts`에 `channel.stream.method = stream(args, progress, complete)` 추가.
2. Main channel registration에 `stream: { method: handler }` 추가.
3. Handler는 transport id를 받거나 생성하지 않는다.
4. Renderer store/service는 `ipcStream`의 progress callback에서 state를 갱신하고 `promise`에서 complete/error를 처리한다.
5. Regression test는 helper 직접 호출이 아니라 route → stream event → store까지 통과하는 round-trip을 포함한다.
