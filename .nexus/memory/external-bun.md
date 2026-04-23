# external-bun

스냅샷 날짜: 2026-04

## 현재 상태 요약

- **최신 버전**: v1.3.13 (2026-04-20 출시)
- **거버넌스**: 2025-12 Anthropic이 인수 (Anthropic 최초 M&A). MIT 라이선스 유지. Oven 팀이 Anthropic 산하에서 개발 계속.
- **주요 채택 사례**: Midjourney, Lovable, Trigger.dev, Claude Code (Bun 컴파일 바이너리로 배포). Trigger.dev는 Node.js → Bun 전환 후 처리량 5배 실측.

## 우리 아키텍처에서의 역할

**탈락.** sidecar 런타임 후보였으나 채택하지 않음. Bun.spawn 장기 실행 시 자식 프로세스 RSS 점진 증가 이슈(#21560)가 M4 P1 always-on 정책(워크스페이스당 sidecar 항상 running)과 정면 충돌하여 탈락. Go sidecar로 대체.

## 성능 수치

- Cold start: 8-15ms vs Node.js 40-120ms (4-10배 빠름)
- Idle RSS: ~28MB vs Node.js ~55MB
- 10 워크스페이스 기준 예상: 250-300MB vs 500-600MB (Node.js 대비 절반)

## Bun.Terminal API (PTY)

v1.3.5(2025-12)에서 네이티브 PTY API 도입. node-pty 없이 macOS/Linux에서 PTY 관리 가능. Windows 미지원(#25593). 출시 4개월 미만으로 프로덕션 검증 부족.

## 알려진 구체 이슈

| 이슈 | 상태 | 내용 |
|---|---|---|
| #21560 | OPEN | Bun.spawn 자식 프로세스 장기 실행 RSS 점진 증가. 최초 2025-08, v1.3.6(2026-01-20)에서도 재현. 라벨: bug+performance. 원보고자는 Bun→Go gRPC 전환으로 해결. |
| #18265 | CLOSED (재발) | polling 누수. PR #18316로 2025-05-31 CLOSED. 그러나 canary 빌드에서 동일 메커니즘 재현. 재수정 PR #29416 (2026-04-17 머지, v1.3.13 미포함). |
| #25593 | OPEN | Bun.Terminal Windows 미지원 |

**교차 증거**: claude-code 이슈 #36132(2026-04-11). 사용자가 Bun v1.3.11에서 8시간 idle 후 commit 메모리 10.6GB + mimalloc panic 보고. Node.js 전환 후 안정화. Anthropic 내부 이슈 트래커 출처로 신뢰도 높음.

**v1.3.13 릴리스 위생**: mimalloc v3 업그레이드를 블로그에서 발표했으나 PR #29353(mimalloc v3 revert, 2026-04-15)이 릴리스 전 머지되어 실제 배포 바이너리는 v2 복귀 상태로 추정.

## 재현 조건별 영향

- stdout=pipe + 장기 실행 + IPC + Linux → 직접 정면 충돌
- stdio=ignore → 3시간 RSS 14-18MB 안정
- macOS는 Linux 대비 증가 폭 작음 (MADV_FREE vs MADV_DONTNEED 차이)

M4 P1 sidecar 예상 거동: LSP/PTY/harness 3종 × 10 워크스페이스 × 6-12시간 누적 시 수 GB RSS 누적 가능성.

## 라이선스

MIT

## 출처

- https://bun.sh
- https://github.com/oven-sh/bun
- https://github.com/oven-sh/bun/issues/21560
- https://github.com/oven-sh/bun/issues/18265
- https://github.com/anthropics/claude-code/issues/36132
