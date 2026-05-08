# empirical: broadcast request correlation bug

## 관찰

Search가 `4 results in 0 files`처럼 match count와 file group count가 서로 어긋나는 상태가 됐다. 원인은 transport request correlation과 domain result correlation을 같은 `requestId`로 섞은 것이다.

기존 구조는 renderer가 `ipcCall("fs", "searchText", ..., requestId)`를 시작하고, main search handler가 별도 `broadcast("fs", "searchProgress", { requestId, batch })`를 보냈다. Store는 broadcast progress의 `requestId`가 현재 session과 같을 때만 batch를 붙였다. transport와 domain namespace가 분리되지 않으면 progress가 잘못 drop되거나 stale 처리될 수 있다.

## 왜 기존 테스트가 놓쳤나

Store 단위 테스트가 `_storeHelpers.appendBatch(requestId, batch)`를 직접 호출했다. 이 방식은 실제 IPC round-trip과 preload/client demux 경로를 우회하므로, transport 상관관계가 깨져도 helper만 맞으면 통과한다.

## 교훈

- 도메인 progress schema에 transport key(`requestId`, `streamId`)를 넣지 않는다.
- 요청 단위 progress는 `ipcStream`을 사용해 router가 `streamId`를 소유하게 한다.
- Store 테스트는 transport를 완전히 우회하는 helper 직접 호출에 의존하지 않는다.
- 이 클래스의 회귀 방지는 route → stream event → client/store까지 통과하는 round-trip 통합 테스트가 필요하다.

## 이번 사이클의 방지선

`tests/integration/renderer/search/round-trip.test.ts`가 fixture 3개 파일 / 4개 `needle` match를 실제 stream path로 실행하고 `session.results.length === 3`, `matchesFound === 4`를 검증한다.
