# Pattern: LSP/Agent channel bottleneck — two orthogonal axes

이 메모는 nexus-code에서 LSP를 켰을 때 발생하는 성능/안정성 문제(hover/definition
timeout, wedge restart, 파일트리 폴더 누락, PTY 입력 지연 등)를 진단할 때 사용할
판단 축을 정리한다. 동일한 토폴로지 위에서 비슷한 증상이 다시 나타나면 우선
이 두 축으로 분해하라.

## 컨텍스트

- 코드 매핑 결과: 같은 워크스페이스 안에서 LSP / FS / PTY 가 **단일
  `AgentChannel` 인스턴스 위에서 multiplex** 된다.
  - `src/main/features/workspace/manager.ts` — `localChannels: Map<workspaceId, AgentChannel>`
  - `getAgentChannel(id)` 가 LSP host, FS provider, PTY 셋 모두에게 동일 instance 반환
- Go agent 측 응답 경로는 **single `outMu` writer mutex** 로 직렬화된다
  (`internal/lsp/host.go`).
- 워크스페이스 진입 시 `ensureRoot` → `Promise.all` 로 hydrated paths
  `loadChildren` 들이 한꺼번에 발사된다 (`src/renderer/state/operations/files.ts`).
  동시에 열려있던 에디터들이 LSP `didOpen` 을 같이 발사한다. **이 시점이
  채널 saturation 의 1차 표적**.

## 두 직교 축

| 축 | 정체 | 증상 | 원인 |
|---|---|---|---|
| **L1 외부 격리** | LSP 와 FS/PTY 가 같은 channel 공유 | 파일트리 폴더 누락 (정황 증거 등급), PTY 입력 지연 | LSP 가 writer를 점유하면 같은 워크스페이스의 fs.readdir / pty.write 응답도 지연/유실 |
| **L2 내부 직렬화** | 같은 LSP 채널 안에서 여러 LSP 서버 응답이 outMu 단일 통과 | hover/definition timeout, wedge restart | 멀티 LSP (TS+Python 또는 멀티 워크스페이스) 시 서로 writer를 다툼 |

핵심: **두 축은 직교한다**. 채널 분리는 L1만 푼다. L2는 채널을 아무리 나눠도
한 LSP 채널 안에서 두 LSP 서버가 같은 writer를 공유하면 그대로 남는다.
한 축의 해결이 다른 축의 증상을 자동으로 줄여주지 않는다.

## 채널 분리 깊이 옵션

| 옵션 | 분리 축 | 해결 범위 | 비용 |
|---|---|---|---|
| **i** | feature 별 (LSP / FS / PTY) | L1 | 중 |
| **ii** | i + LSP 서버 별 (LSP-TS / LSP-Python) | L1 + L2 부분 | 중-상 |
| **iii** | ii + Go agent 내부 per-LSP writer goroutine | L1 + L2 완전 | 상 |

옵션 ii vs iii 의 갈림길은 **outMu hold time p99**. 측정 없이 결정 금지.
fire-and-forget 적용 후 outMu가 가볍게 풀렸으면 ii로 충분, 여전히 무거우면 iii.

## 구현 방식 두 갈래

- **A. process 다중화**: workspace 당 agent process 1개 → N개 (feature 수).
  각 stdio 통로 분리. spawn 비용 + lifecycle 복잡도 + 메모리 N배. 가장 깔끔하지만
  무거움.
- **B. stream 다중화** (권장 기본값): 한 process 안에서 NDJSON frame에 stream-id 를
  붙여 feature 별 writer/reader pair로 라우팅. process 수 그대로, framing 변경.
  더 가벼움.

**주의**: B는 outMu(Go side single mutex)는 해결하지 못한다. 진짜 내부 동시성은
옵션 iii(per-LSP writer goroutine)에서 온다. B + iii 가 자연스러운 조합.

## 측정 우선 원칙

큰 작업으로 들어가기 전 항상 측정 먼저. 측정 없이 옵션 ii 이상을 구현하지 말 것.
다음 메트릭을 env-var gated 디버그 로그로 수집:

1. **outMu hold time** (p50/p99) — L2 강도 정량화
2. **pendingRequests depth** — TS pipe 측 backpressure
3. **didChange / hover / definition rate** per server — 트래픽 패턴
4. **fs.readdir 응답 시간** — L1 영향을 정량화하는 핵심 지표
5. **handleStdoutLine 처리 시간** — Go 측 응답 latency
6. **stdin write blocking time** — channel writer 점유

LSP가 비활성화된 상태에서는 측정 불가 → 측정 사이클은 LSP를 임시로 켜야 한다.

## 결정 알고리즘 (측정 결과 → 옵션)

```
if outMu p99 < 50ms:
    L2 is light; fire-and-forget이 충분히 풀었음
    → 옵션 i (L1만 분리) 로 충분
elif outMu p99 in [50ms, 200ms):
    L2 중간; 옵션 ii (LSP 서버별 채널 분기)
else:  # >= 200ms
    L2 심각; 옵션 iii (per-LSP writer goroutine) 까지
```

또한 fs.readdir 응답이 LSP 트래픽과 강한 correlation 을 보이면 L1 우선,
약하면 L2 우선.

## 정직한 한계

- **가설 A (파일트리 누락 = L1 saturation)는 정황 증거 등급**. 발생 시점 로그가
  없어 확정 불가. 코드 구조상 가능성 높고 사용자 보고("LSP off 후 재현 안 됨")와
  부합하지만, 다른 원인(예: watcher race, react state hydration)도 배제 못함.
- **fire-and-forget(commit 33fc99e) 만으로 L2가 충분히 풀렸을 가능성**이
  존재한다. 만약 그렇다면 옵션 ii 이상은 과잉이고 옵션 i + fire-and-forget
  조합으로 끝날 수 있다. 측정으로만 확인 가능.

## 관련 코드 앵커

- `src/main/features/workspace/manager.ts:290` — `getAgentChannel` 공유 지점
- `src/main/infra/agent/pipe.ts` — TS 측 channel writer / pendingRequests
- `src/main/infra/agent/channel/index.ts` — `AgentChannel` 인터페이스 (call/fire)
- `internal/lsp/host.go` — Go 측 outMu / per-server lifecycle
- `internal/lsp/service.go` — `lsp.send` (RPC) / `lsp.notify` (fire-and-forget) 핸들러
- `src/renderer/state/operations/files.ts` — `ensureRoot` 의 Promise.all hydrated load
- `src/renderer/state/stores/files/store.ts:112` — `setChildrenError` (자식 폴더 실패가 UI에 안 보이는 이유)
- `src/renderer/components/files/file-tree/status-view.tsx` — root-only 에러 표시

## 관련 메모

- `pattern-ipc-stream.md` — IPC 프레이밍 일반 규약
- `empirical-reconnecting-channel-backpressure.md` — channel 백프레셔 사례
- `empirical-lsp-env-inheritance.md` — LSP 환경 변수

## 적용 이력

- 2026-05-20: 사용자가 "근본 해결책 = 채널 분리 + LSP 병목 해결" 직관을 제시.
  코드 매핑 결과로 두 축의 직교성 확인. 측정 + 옵션 결정 알고리즘 합의.
  당시 LSP_FEATURE_ENABLED=false 상태(commit c61ab6f)였고 본격 진입은 정책 결정
  이후로 보류됨.
