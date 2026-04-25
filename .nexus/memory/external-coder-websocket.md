# coder/websocket 외부 사실

외부 프로젝트 사실 스냅샷. 우리 제어 범위 밖이다.

## 소유·인수 경위

원본 저자는 nhooyr(Anmol Sethi)이며, 2024년 8월 Coder사로 인수되었다. 인수 이전부터 maintainer burnout이 공개적으로 언급되었으며, Coder사 인수 후에도 기존 API 안정성은 유지되었다. 저장소는 `github.com/coder/websocket`으로 이전되었다.

## 현재 상태

- **안정 버전**: v1.8.14 (2025-09 기준 최신)
- **라이선스**: ISC
- **v2 로드맵**: 존재하나 미출시. breaking 변경 약속은 공개적으로 남겨지지 않았다. v2 출시 시 마이그레이션 가이드를 제공할 것으로 기대되나, 보장은 없다.
- **유지보수 리듬**: v1.8.x 시리즈는 안정 운영 중. 보안 패치와 버그 수정이 지속적으로 병합된다.

## 본 프로젝트 적합도

sidecar ↔ main 간 단일 연결 push 서버에 적합하다.

- `context` first-class API: Go 표준 컨텍스트를 기반으로 취소·타임아웃이 자연스럽다.
- `wsjson` 서브패키지: JSON 메시지 인코딩·디코딩을 별도 도구 없이 처리한다.
- zero allocation: 고빈도 메시지 스트림에서 GC 부담이 적다.
- 표준 `net/http` 기반: sidecar의 기존 HTTP 서버 구조와 통합이 간단하다.

## 안정성 실측

본 사이클(plan #15 T7)에서는 60초 단축 soak 테스트를 통과했다. 30분 이상 장기 연속 안정성은 nightly job(`.github/workflows/sidecar-soak-nightly.yml`)으로 후속 검증한다. 이 검증이 완료되기 전까지 E3 릴리스 블로커 항목("sidecar WebSocket이 하네스당 최소 30분 연속 동작에서 이벤트 누락 없음")은 열린 상태로 유지한다.

## Heartbeat 정책

architect 결정에 따른 heartbeat 규약:

- ping 주기: 15초 (`c.Ping(ctx)`)
- ping 타임아웃: 5초
- 연속 실패 한계: 2회 → 연결 종료

이 정책은 `sidecar/internal/wsx/` 구현체에 하드코딩되며, facade를 통해 향후 조정 가능하다.

## Close Handshake Race

SIGTERM 경로에서 sidecar가 `server.Close(1001 going-away)`를 의도했으나, main 측 `ws@8.x`에서 1000(normal closure)으로 관측되는 race가 발견되었다.

- 정적 분석으로는 1000이 wire에 도달하는 정확 경로를 단정할 수 없다.
- 추정 원인: `coder/websocket`의 readLoop 난에서 `defer conn.CloseNow()` + `ws@8.x`의 `receiverOnConclude`에서 `casClosing` race.
- 본 사이클 임시 처리: `lifecycle-smoke.test.ts` SIGTERM expect를 `[1000, 1001, 1006]`로 약화.
- 다음 사이클 진단 절차: `tcpdump -i lo0 port <sidecar_port>`로 wire 캡처 1회 → 실제 close frame 코드 결정 → 라이브러리 issue 보고 또는 우회 fix.

## 관련 문서

- `.nexus/memory/pattern-sidecar-close-code-race.md`: race 진단 레시피
- `.nexus/context/stack.md`: WebSocket 묶음 업그레이드 정책
