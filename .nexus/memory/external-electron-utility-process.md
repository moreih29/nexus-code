# external-electron-utility-process

스냅샷 날짜: 2026-04

## 현재 상태 요약

Electron Utility Process는 Electron 22부터 공식 API로 제공되며, Electron 공식 문서의 `electron/api/utility-process` 항목에 포함된다. Electron 프로젝트(OpenJS Foundation)가 Electron 메이저 버전과 함께 유지한다.

## 우리 아키텍처에서의 역할

nexus-code에서 Utility Process는 선택적 활용 대상이다. Go sidecar는 정적 바이너리이므로 `child_process.spawn`만으로도 실행 가능하다. Utility Process를 쓰면 MessagePort 기반 renderer 직접 통신과 crash isolation 이점을 얻을 수 있지만, MVP는 단순 IPC(WebSocket 또는 stdio)로 시작하고 성능·안정성 필요가 확인될 때 전환을 검토한다.

## 결정 기준

- `child_process.fork`는 Node.js 모듈 실행에 맞고, Go sidecar에는 `spawn` 패턴이 더 자연스럽다.
- renderer와 sidecar 간 직접 통신이 필요해지면 Utility Process의 MessagePort 채널이 검토 가치가 있다.
- crash isolation만 필요하다면 별도 프로세스 spawn과 재시작 watchdog으로도 유사한 운영 효과를 낼 수 있다.
- Electron 메이저 업그레이드 시 Utility Process API 변경 사항은 Electron 릴리스 노트와 공식 블로그에서 추적한다.

## 라이선스

Electron 자체: MIT

## 출처

- https://www.electronjs.org/docs/latest/api/utility-process
- https://www.electronjs.org/blog/electron-22-0 (Utility Process 도입 발표)
