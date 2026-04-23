# external-xterm-js

스냅샷 날짜: 2026-04

## 현재 상태 요약

- **거버넌스**: xtermjs 오픈소스 프로젝트. Microsoft, JetBrains, The Eclipse Foundation 등 주요 기여자.
- **채택 사례**: VS Code, JetBrains IDE, Hyper, Eclipse Theia, Gitpod. 터미널 에뮬레이터 라이브러리의 사실상 업계 표준.
- **패키지**: `@xterm/xterm` (코어), `@xterm/addon-webgl` (WebGL 렌더러), `@xterm/addon-canvas` (Canvas 렌더러), `@xterm/addon-fit` (크기 자동 맞춤), `@xterm/addon-unicode11` (Unicode 11 지원).

## 우리 아키텍처에서의 역할

**채택.** nexus-code의 renderer 프로세스에서 터미널 에뮬레이터로 사용. `@xterm/addon-webgl` WebGL 렌더러와 함께 구성. 워크스페이스당 다중 터미널 탭을 지원하며, PTY 실제 제어는 Electron main 프로세스의 node-pty가 담당하고 xterm.js는 렌더링과 사용자 입력 처리만 맡음(VSCode 패턴). IME 이슈 #5734는 Issue 6 한국어 체크리스트에서 선제 회피 계획 수립 완료.

## 성능

WebGL 렌더러(`@xterm/addon-webgl`)는 Canvas 렌더러 대비 900%+ 빠름. GPU 가속으로 대량 출력 시에도 프레임 드롭 없음.

## 알려진 구체 이슈

| 이슈 | 상태 | 내용 |
|---|---|---|
| #5734 | OPEN (2026-03) | IME composing 위치 오류. 한국어 IME 조합 중 composing 창이 입력 위치가 아닌 잘못된 좌표에 표시. placeholder가 있을 때 특히 잘못됨. 우리 한국어 체크리스트 항목 1번. |
| #1453 | OPEN | ambiguous width 문자 처리 불일치. 동아시아 문자 중 폭이 환경마다 다른 코드포인트 처리 문제. |
| #4753 | OPEN | Unicode 버전 표기 오류. 라이브러리 내부 Unicode 버전 메타데이터 불일치. |

**회피 전략**: #5734는 composingstart/composingend 이벤트로 오버레이 패치 적용. 필요 시 upstream PR 기여 또는 fork 유지.

## 우리 한국어 체크리스트와의 관계

Issue 6 릴리스 전 필수 통과 7개 항목 중 #5734가 항목 1번(조합 중 커서 위치)과 항목 2번(조합 중 Enter 처리)에 직결. xterm.js 코어 패치 없이는 두 항목 통과 불가 — 오버레이 패치 또는 fork가 필수.

## 라이선스

MIT

## 출처

- https://xtermjs.org
- https://github.com/xtermjs/xterm.js
- https://github.com/xtermjs/xterm.js/issues/5734
- https://github.com/xtermjs/xterm.js/issues/1453
- https://github.com/xtermjs/xterm.js/issues/4753
