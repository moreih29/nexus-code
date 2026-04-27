# Sidecar Close Code Race 패턴

유사한 WebSocket close handshake race 문제에 재사용할 진단 레시피다.

## 현상

SIGTERM 경로에서 sidecar가 `server.Close(1001 going-away)`를 의도했으나, main 측 `ws@8.x`에서 1000(normal closure)으로 관측되는 race가 발견되었다.

Electron main에서는 1006도 관측될 수 있어, 사용자 영향이 없더라도 테스트 판정 기준이 흔들릴 수 있다. wire 기준의 사실과 main 관측값을 분리해 기록한다.

## 판단 원칙

source-level 분석만으로는 race의 승자를 예측하기 어렵다. `coder/websocket` 쪽 `defer conn.CloseNow()`와 `ws@8.x` 쪽 `receiverOnConclude`/`casClosing` 경로가 interleave되면, 실제 wire close frame과 main event close code가 다르게 보일 수 있다.

따라서 close code race는 다음 순서로 다룬다.

1. schema 상수, 중복 close 기록, signal handling 위치처럼 명백한 local 원인을 먼저 제거한다.
2. 그래도 재현되면 packet pcap 또는 raw RFC6455 client로 server-originated close frame을 직접 확인한다.
3. wire가 1000이면 `coder/websocket` 또는 sidecar 내부에서 의도한 1001이 바뀌는 경로를 추적한다.
4. wire가 1001이면 `ws@8.x` close event 처리 또는 main-side event 합성 경로를 의심한다.

## 진단 레시피

macOS에서는 비권한 `tcpdump`가 BPF 권한 문제로 실패할 수 있다. 권한 있는 pcap을 사용할 수 없으면 raw RFC6455 client가 대체 경로다.

raw capture는 sidecar를 직접 기동하고, HTTP Upgrade 후 sidecar start frame을 보낸 뒤, SIGTERM 직후 서버가 보낸 opcode 8 close frame payload를 client echo 전에 읽는다. 이 방식은 pcap은 아니지만 application-wire close payload를 확인할 수 있다.

실측에서는 raw socket 기준 server-originated close frame이 `1001 going away`였다. 따라서 현재 의심 우선순위는 `ws@8.x` close event 경로 또는 main-side close event 합성 경로다.

## 임시 판정 정책

사용자 영향이 없고 exact fix가 별도 backlog라면, lifecycle smoke의 SIGTERM expect set은 `[1000, 1001, 1006]`처럼 관측 가능한 정상 범위를 허용한다. 단, 이 완화는 기능적 정확성 판정이 아니라 race 진단이 끝나기 전 테스트 flake를 줄이는 임시 처리로 문서화한다.

## 관련 문서

- `.nexus/memory/external-coder-websocket.md`: 라이브러리 상태 및 heartbeat 정책
- `.nexus/context/stack.md`: WebSocket 묶음 업그레이드 정책
