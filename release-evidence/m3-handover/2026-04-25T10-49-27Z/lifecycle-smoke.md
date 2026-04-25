# T7 통합 검증 재시도 — lifecycle handshake smoke

- 실행 시각(UTC): 2026-04-25T10:49:27Z
- 실행 환경: macOS(darwin), Bun 1.3.13, actual sidecar binary(`go build -o sidecar/bin/nexus-sidecar ./cmd/nexus-sidecar` via test `beforeAll`)
- 명령: `bun test ./packages/app/test/integration/sidecar-lifecycle/`
- 결과: **FAIL — 5 PASS / 1 FAIL**

## Acceptance 결과

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| 통합 smoke 4 시나리오 PASS | FAIL | 정상 lifecycle, crash dedupe, fatal token은 통과했으나 close code 상호운용성에서 SIGTERM 기대값 1001 대비 실제 1000 관측 |
| Graceful shutdown 측정 | PASS | 10회 반복 평균 21.3ms로 500ms 미만 |
| 60s 단축 idle soak | PASS | 63s 유지, heartbeat ping 4회, heap monotonic 증가 없음 |
| 30분 nightly soak workflow yml 보존 | PASS | `.github/workflows/sidecar-soak-nightly.yml` 존재 확인, 본 재검증에서 수정 없음 |
| 산출물 갱신 | PASS | 본 파일을 새 timestamp 디렉터리에 신설 |
| `bun test ./packages/app/test/integration/sidecar-lifecycle/` 6 PASS / 0 FAIL | FAIL | 실제 결과 5 PASS / 1 FAIL |

## 측정값

### Graceful shutdown

테스트 로그:

```text
graceful-shutdown-ms avg=21.3 p50=21.6 p95=21.8 max=21.8
```

- 평균: 21.3ms
- p50: 21.6ms
- p95: 21.8ms
- max: 21.8ms

### 60s idle soak

테스트 로그:

```text
idle-soak durationMs=63000 pingCount=4 rssDelta=2211840 heapUsedDelta=-425168 heapSamples=2190870,2385935,1758350,1765638,1765702,1765702
```

- durationMs: 63,000ms
- heartbeat pingCount: 4
- rssDelta: +2,211,840 bytes
- heapUsedDelta: -425,168 bytes
- heapSamples: 2,190,870 → 2,385,935 → 1,758,350 → 1,765,638 → 1,765,702 → 1,765,702
- 판정: heap sample이 단조 증가하지 않았고 최종 heap delta는 감소

## 실패 상세

### Close code 상호운용성 — SIGTERM going away

전체 실행 실패:

```text
Expected: 1001
Received: 1000

packages/app/test/integration/sidecar-lifecycle/lifecycle-smoke.test.ts:79:70
```

재현 확인(동일 focused test):

```text
bun test ./packages/app/test/integration/sidecar-lifecycle/lifecycle-smoke.test.ts -t "Close code"

Expected: 1001
Received: 1000
0 pass / 1 fail / 3 filtered out
```

관련 관찰:

- `sidecar/cmd/nexus-sidecar/main.go`의 signal handler는 SIGTERM 수신 시 `handler.SendStopped(ctx, nil)` 후 `server.Close(wsx.StatusGoingAway, "going away")`를 호출하도록 구현되어 있음.
- main bridge는 `packages/app/src/main/sidecar-bridge/index.ts`에서 `sidecar/stopped` 메시지를 받으면 `record.lifecycleEmitter.recordWsClose(1000, true)`를 먼저 기록하고 cleanup을 수행함.
- 현상상 SIGTERM 경로에서 실제 close 이벤트 관측값이 1001이 아니라 1000으로 노출되어 acceptance의 close code 상호운용성 기준을 만족하지 못함.

## 원 명령 출력 요약

```text
bun test v1.3.13 (bf2e2cec)

packages/app/test/integration/sidecar-lifecycle/idle-soak-60s.test.ts:
[bun] Warning: ws.WebSocket 'unexpected-response' event is not implemented in bun
idle-soak durationMs=63000 pingCount=4 rssDelta=2211840 heapUsedDelta=-425168 heapSamples=2190870,2385935,1758350,1765638,1765702,1765702

packages/app/test/integration/sidecar-lifecycle/lifecycle-smoke.test.ts:
error: expect(received).toBe(expected)
Expected: 1001
Received: 1000
(fail) sidecar lifecycle integration smoke > Close code 상호운용성: 1000(stop), 1001(SIGTERM), 1006(SIGKILL)을 main onclose에서 관측한다

packages/app/test/integration/sidecar-lifecycle/graceful-shutdown.test.ts:
graceful-shutdown-ms avg=21.3 p50=21.6 p95=21.8 max=21.8

5 pass
1 fail
30 expect() calls
Ran 6 tests across 3 files. [72.44s]
```
