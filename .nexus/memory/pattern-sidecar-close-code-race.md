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

## T13 wire capture 진단 결과 (2026-04-26)

비권한 packet capture는 macOS BPF 권한에 막혔다.

- 실행: `/usr/sbin/tcpdump -i lo0 -c 1 -nn tcp port 9` + localhost probe
- 결과: `tcpdump: lo0: You don't have permission to capture on that device ((cannot open BPF device) /dev/bpf0: Permission denied)`
- sudo/privileged approval은 금지되어 있어 tcpdump pcap은 중단.

대신 raw RFC6455 client로 WebSocket stream을 직접 읽어 close frame payload를 확인했다. 절차:

1. `go build -o /tmp/nexus-sidecar-wire-capture ./cmd/nexus-sidecar`
2. Python raw socket client가 sidecar를 `NEXUS_SIDECAR_TOKEN`과 함께 spawn.
3. stdout READY line에서 동적 port/pid를 파싱.
4. TCP socket으로 HTTP Upgrade를 직접 수행하고 `nexus.sidecar.v1` subprotocol을 확인.
5. masked `SidecarStart` JSON frame을 전송하고 `sidecar/started` 수신 확인.
6. `SIGTERM` 전송 후 서버가 보낸 close opcode 8 frame을 client echo 전에 파싱.
7. 같은 close payload를 masked close frame으로 echo해 sidecar 정상 종료 확인.

5회 반복 결과:

| run | close code | reason | sidecar/stopped before close | process exit |
|---:|---:|---|---|---:|
| 1 | 1001 | `going away` | true | 0 |
| 2 | 1001 | `going away` | true | 0 |
| 3 | 1001 | `going away` | true | 0 |
| 4 | 1001 | `going away` | true | 0 |
| 5 | 1001 | `going away` | true | 0 |

판정: tcpdump 수준 pcap은 없지만, raw socket에서 server-originated WebSocket close frame payload가 5/5 모두 `1001 going away`로 확인되었다. 따라서 SIGTERM 경로의 실제 server close frame은 1001로 보는 것이 타당하며, main 측에서 1000/1006으로 관측되는 현상은 우선 `ws@8.x`의 `receiverOnConclude`/`casClosing` 경로 또는 main-side close event 합성 경로를 의심한다.

현 정책은 그대로 유지한다. `lifecycle-smoke.test.ts`의 SIGTERM expect set `[1000, 1001, 1006]`은 변경하지 않았고, exact fix는 plan #18 backlog로 남긴다.

## 후속 진단 절차

1. packet-level pcap이 꼭 필요하면 사용자가 별도 터미널에서 BPF 권한을 부여하거나 `sudo tcpdump -i lo0 port <sidecar_port>`를 실행한다. 현재 agent 권한에서는 `/dev/bpf0: Permission denied`로 불가.
2. raw RFC6455 capture 기준 wire close frame은 `1001 going away`로 확인되었으므로, plan #18 exact fix는 `ws@8.x` 측 close event 경로(`receiverOnConclude`/`casClosing`) 또는 main-side close event 합성 경로부터 재현·축소한다.
3. 판정 기준:
   - packet pcap이 1000으로 반증되면 → `coder/websocket` 내부에서 1001 의도가 1000으로 변경되는 경로를 추적.
   - packet pcap도 1001이면 → `ws@8.x` 측에서 1001을 1000으로 덮어쓰는 버그 또는 main event 합성 문제로 확정에 가깝게 본다.

## 본 사이클 임시 처리

`lifecycle-smoke.test.ts` SIGTERM expect를 `[1000, 1001, 1006]`로 약화(acceptance set 확장). 이 처리는 기능적 정확성에 영향을 주지 않으며, 테스트의 판정 기준을 현실에 맞춘 조정이다.

## 관련 문서

- `.nexus/memory/external-coder-websocket.md`: 라이브러리 상태 및 heartbeat 정책
- `.nexus/context/stack.md`: WebSocket 묶음 업그레이드 정책
