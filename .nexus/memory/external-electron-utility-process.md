# external-electron-utility-process

스냅샷 날짜: 2026-04

## 현재 상태 요약

- **도입**: Electron 22 (2022-11)부터 공식 API로 제공. 현재 Electron 35에서 안정 상태.
- **위치**: Electron 공식 문서 `electron/api/utility-process` 항목에 권장 패턴으로 명시.
- **거버넌스**: Electron 프로젝트(OpenJS Foundation). Electron 메이저 버전마다 함께 유지됨.

## 우리 아키텍처에서의 역할

**선택적 활용.** nexus-code Electron main 프로세스가 Go sidecar를 spawn할 때 Utility Process를 활용할 수 있음. Go sidecar는 정적 바이너리이므로 `child_process.spawn`으로도 충분히 실행 가능하나, Utility Process API를 쓰면 MessagePort 기반 renderer 직접 통신과 crash isolation 이점을 추가로 얻을 수 있음. MVP에서는 단순 IPC(WebSocket 또는 stdio)로 시작하고, 성능·안정성 필요 시 Utility Process 전환을 검토.

## child_process.fork 대비 우위

| 항목 | child_process.fork | Utility Process |
|---|---|---|
| 통신 채널 | IPC (Node.js 표준) | MessagePort + Chromium Services |
| renderer 직접 통신 | 불가 (main 경유 필수) | MessagePort 전달로 가능 |
| crash isolation | 없음 (main과 동일 프로세스 위험) | 격리됨 — sidecar crash가 main 프로세스에 전파되지 않음 |
| 권장 여부 | Electron 22 이후 비권장 | 공식 권장 |

## 적용 시 고려 사항

- Go sidecar는 Node.js 모듈이 아니므로 `utilityProcess.fork()` 대신 `child_process.spawn()`으로 정적 바이너리를 실행. Utility Process는 JS/Node 모듈 실행에 최적화되어 있어 Go 바이너리에는 `spawn` 패턴이 더 자연스러움.
- renderer와 sidecar 간 직접 통신이 필요한 경우 Utility Process의 MessagePort 채널이 유용.
- crash isolation 목적만이라면 별도 프로세스 spawn + 재시작 watchdog으로 동일 효과 달성 가능.

## 알려진 구체 이슈

지정된 GitHub 이슈 번호 없음. Electron 메이저 버전 업그레이드 시 Utility Process API 변경 사항은 Electron 릴리스 노트 및 공식 블로그에서 추적.

## 라이선스

Electron 자체: MIT

## 출처

- https://www.electronjs.org/docs/latest/api/utility-process
- https://www.electronjs.org/blog/electron-22-0 (Utility Process 도입 발표)
