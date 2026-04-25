# Sidecar Lifecycle Handshake 패턴

재사용 가능한 레시피. sidecar 프로세스와 main 프로세스 간 신뢰할 수 있는 연결 수립·종료 절차를 정의한다.

## 패턴 핵심

1. **동적 포트 0-bind**: sidecar가 `localhost:0`으로 bind하고 실제 포트를 stdout 첫 줄 `"NEXUS_SIDECAR_READY port=<port> pid=<pid> proto=ws v=1\n"` prefix로 전달한다. main은 첫 줄까지만 줄단위 파싱하고 이후 stdout은 일반 로그 stream으로 연결한다.
2. **env var token**: sidecar는 `NEXUS_SIDECAR_TOKEN` 환경변수에서 인증 토큰을 읽는다. main은 프로세스 생성 시 랜덤 토큰(`crypto.randomBytes(32).toString('hex')` 64자)을 주입한다.
3. **X-Sidecar-Token 헤더**: WebSocket upgrade 요청에 토큰을 헤더로 포함한다.
4. **WS subprotocol "nexus.sidecar.v1"**: 명시적 서브프로토콜 협상으로 버전 불일치를 조기에 차단한다.
5. **명시 왕복 handshake**: 연결 수립 후 `SidecarStart` → `Started`, 종료 시 `Stop` → `Stopped` 메시지를 주고받는다.
6. **1:1 child binding**: 한 sidecar 프로세스는 한 워크스페이스에만 대응한다.
7. **epoch UUID dedupe**: 연결 재시도 시 동일 epoch UUID로 중복 연결을 방지한다.
8. **crash reason 합성(main 측)**: sidecar가 비정상 종료하면 exit code + signal + stderr tail을 조합해 main 측에서 crash reason을 생성한다.

## 발생 맥락

plan #15에서 architect §3 시퀀스와 Issue 4 결정을 통해 수립되었다. 기존 고정 포트 + implicit 연결 모델의 불확실성을 제거하기 위해 도입되었다.

## 핵심 결정 축

| 축 | 본 패턴 선택 | 대안 | 선택 이유 |
|---|---|---|---|
| 포트 할당 | 동적 0-bind | 고정 포트 | 다중 워크스페이스·프로세스 충돌 방지 |
| 토큰 전달 | env var | argv | 프로세스 목록 노출 최소화 |
| handshake | 명시 메시지(SidecarStart/Started/Stop/Stopped) | implicit 연결 성공 | 양방향 상태 동기화, 재연결 시 혼란 방지 |
| 종료 에스컬레이션 | WS Stop/Stopped 후 SIGTERM | WS-only 또는 SIGTERM-only | 우아한 종료 시도 후 강제 종료 |
| dedupe | epoch UUID | PID 기준 | PID 재사용(reaping 미완) 문제 회피 |

## 실패 경로 매트릭스(핵심 5건)

architect §"실패 경로 매트릭스" 17건 중 본 패턴 설계에 직접 영향을 준 핵심 5건:

1. **포트 충돌**: 고정 포트 사용 시 다중 워크스페이스 동시 실행에서 `EADDRINUSE`. → 동적 포트로 회피.
2. **연결 도달 전 요청**: sidecar가 아직 READY를 출력하기 전에 main이 연결 시도. → stdout 라인 기반 동기화로 회피.
3. **토큰 탈취**: argv로 토큰 전달 시 `ps` 노출. → env var로 회피.
4. **zombie 연결**: 이전 epoch의 연결이 끊기지 않은 채 새 연결 수립. → epoch UUID dedupe gate로 회피.
5. **우아 종료 무시**: sidecar가 WS StopCommand/SIGTERM을 무시하고 계속 실행. → 종료 에스컬레이션 단계: WS StopCommand → 1s 무응답 → SIGTERM → 3s 무응답 → SIGKILL.

## 확장 포인트

- harness-* schema 추가 시 type namespace는 `^[a-z]+/[a-z-]+$` 규약을 따른다.
- envelope 도입(공통 헤더 필드 감싸기)의 ROI 재평가는 E3 진입 직전에 수행한다. 현재는 flat schema로 충분하다.

## 관련 문서

- `.nexus/memory/pattern-sidecar-close-code-race.md`: SIGTERM 종료 경로의 close code race
- `.nexus/memory/external-coder-websocket.md`: WebSocket 라이브러리 선택 근거
- `.nexus/context/stack.md`: WebSocket 묶음 정책
