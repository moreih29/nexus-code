# Lifecycle handshake integration verification

Timestamp: 2026-04-25T10-45-26Z

## 실행 명령

```bash
bun test ./packages/app/test/integration/sidecar-lifecycle
```

## 결과

- 총 6개 테스트 중 1 PASS / 5 FAIL
- PASS: fatal token mismatch는 `WS_401` fatal 및 spawn 1회로 재시도 없음 확인
- FAIL: 정상 lifecycle, crash, close-code, graceful, idle-soak 모두 start handshake 단계에서 실패

## 대표 실패 로그

```text
error: WebSocket closed before StartedEvent
kind: "transient"
code: "STARTED_CLOSE"
at packages/app/src/main/sidecar-bridge/handshake.ts:218:14
```

## 판정

통합 테스트가 실제 sidecar binary와 연결되었으나, `SidecarBridge`가 송신하는 generated TS contract type(`sidecar/start`)과 sidecar handler가 분기하는 type 상수(`SidecarStartCommand`)가 불일치하여 sidecar가 StartedEvent를 반환하지 못하는 것으로 보입니다. 따라서 graceful shutdown 및 60s idle soak 측정은 handshake 선행 실패로 수집하지 못했습니다.

## 조치 필요

- Go sidecar lifecycle handler의 message type 분기와 송신 이벤트 type을 generated TS contract(`sidecar/start`, `sidecar/started`, `sidecar/stop`, `sidecar/stopped`)와 정렬해야 합니다.
- 수정 후 동일 명령으로 smoke 4건, graceful 10회 측정, 60s idle soak를 재실행해야 합니다.
