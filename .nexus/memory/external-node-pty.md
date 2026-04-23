# external-node-pty

스냅샷 날짜: 2026-04

## 현재 상태 요약

- **유지보수**: Microsoft (VS Code 팀). 마지막 업데이트 2026-02.
- **운영 레퍼런스**: VS Code 터미널이 node-pty 기반으로 운영 중. 라이브러리 안정성의 핵심 신뢰 근거.
- **설치 방식**: native addon (C++ 빌드). Electron 환경에서는 `@electron/rebuild`로 대상 Electron 버전에 맞게 재빌드 필요. 매 Electron 메이저 업그레이드마다 반복.

## 우리 아키텍처에서의 역할

**채택.** nexus-code의 터미널 PTY를 Electron **main 프로세스**에서 node-pty로 관리 (VSCode 패턴). xterm.js(renderer 프로세스)와 IPC로 입출력을 주고받음. Go sidecar는 AI 하네스 감독·LSP·파일 와처·git 담당으로 역할 분리 — PTY와 sidecar는 별개 레이어. 매 Electron 메이저 업그레이드 시 `@electron/rebuild` 실행 및 prebuilt 바이너리 확인이 릴리스 체크리스트 항목.

## Electron 호환성 이력

| Electron 버전 | 상태 |
|---|---|
| Electron 33 (2024-11) | rebuild 실패 보고 (#728, C++ 플래그 문제) |
| Electron 34 | 확인 없음 |
| Electron 35 (현재 최신) | prebuilt 바이너리 공식 확인 없음 — 직접 검증 필요 |

## 알려진 구체 이슈

| 이슈 | 상태 | 내용 |
|---|---|---|
| #728 | 보고됨 (2024-11) | Electron 33.2.0에서 rebuild 실패. C++ 컴파일러 플래그 호환 문제. Electron 33 기준 공식 수정 여부 미확인. |

## 운영 주의 사항

- **ABI dance**: Electron이 내장한 Node.js ABI와 node-pty 빌드 ABI가 일치해야 함. Electron 버전 변경 시 반드시 rebuild.
- **배포 시**: `@electron/rebuild` 결과물을 `extraResources`로 패키징. codesign 대상에 포함.
- **prebuilt 바이너리**: node-pty가 Electron 최신 버전용 prebuilt를 제공하지 않으면 직접 빌드 환경 구성 필요.

## 라이선스

MIT

## 출처

- https://github.com/microsoft/node-pty
- https://github.com/microsoft/node-pty/issues/728
- https://github.com/electron/rebuild
