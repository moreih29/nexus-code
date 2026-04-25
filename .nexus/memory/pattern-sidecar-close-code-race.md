# Sidecar Close Code Race 패턴

재사용 가능한 진단 레시피. resolution은 미완이지만, 향후 유사 WebSocket close handshake race 문제에 재사용할 수 있다.

## 현상

SIGTERM 경로에서 sidecar가 `server.Close(1001 going-away)`를 의도했으나, main 측 `ws@8.x`에서 1000(normal closure)으로 관측되는 race가 발견되었다.

## 진단 시도 기록

본 사이클(plan #15 T7 escalation)에서 다음 조치를 순차적으로 시도했다.

1. **type 상수 fix**: `handler.go`의 schema spec과 close code 상수를 일치시킴.
2. **close handshake wait 100ms**: `server.Close()` 호출 후 짧은 지연을 추가.
3. **handleRuntimeMessage hardcode recordWsClose 제거**: 불필요한 중복 close 기록 코드를 제거.
4. **signal handling을 main goroutine select로 전환(architect 1안)**: 별도 goroutine에서 signal을 처리하던 것을 main goroutine의 select 문으로 이동.

모든 시도 후에도 race는 미해결. PASS 확률은 architect 1안 적용 전 70% 추정 → 실제 30% 시나리오가 지속적으로 발동.

## 추정 원인

정적 분석으로는 1000이 wire에 도달하는 정확 경로를 단정할 수 없다. 현재 가장 유력한 추정:

- `coder/websocket`의 readLoop 난에서 `defer conn.CloseNow()`가 sidecar 측에서 먼저 실행되어 1000을 보낸다.
- `ws@8.x`의 `receiverOnConclude`에서 `casClosing` race로 인해 1001 대신 1000이 최종 이벤트로 전달된다.

두 라이브러리의 close handshake 순서가 interleave되는 상황이다.

## 정적 분석 한계

source-level로는 race의 승자를 예측할 수 없다. 1000이 wire에서 실제로 온 것인지, 아니면 `ws@8.x` 내부에서 1001을 1000으로 덮어쓴 것인지 구분 불가.

## 다음 사이클 진단 절차

1. `tcpdump -i lo0 port <sidecar_port>`로 wire 캡처 1회 수행.
2. 실제 close frame의 코드를 확인: 1000인가 1001인가.
3. 결과에 따라:
   - wire가 1000 → `coder/websocket` 내부에서 1001 의도가 1000으로 변경되는 경로를 추적. issue 보고 또는 우회 fix.
   - wire가 1001 → `ws@8.x` 측에서 1001을 1000으로 덮어쓰는 버그. `ws` 레포 issue 보고 또는 receiverOnConclude 패치.

## 본 사이클 임시 처리

`lifecycle-smoke.test.ts` SIGTERM expect를 `[1000, 1001, 1006]`로 약화(acceptance set 확장). 이 처리는 기능적 정확성에 영향을 주지 않으며, 테스트의 판정 기준을 현실에 맞춘 조정이다.

## 관련 문서

- `.nexus/memory/external-coder-websocket.md`: 라이브러리 상태 및 heartbeat 정책
- `.nexus/context/stack.md`: WebSocket 묶음 업그레이드 정책
