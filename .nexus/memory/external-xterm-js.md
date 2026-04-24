# external-xterm-js

스냅샷 날짜: 2026-04-24

## 현재 상태 요약

- **거버넌스**: xtermjs 오픈소스 프로젝트. Microsoft, JetBrains, The Eclipse Foundation 등 주요 기여자.
- **채택 사례**: VS Code, JetBrains IDE, Hyper, Eclipse Theia, Gitpod. 터미널 에뮬레이터 라이브러리의 사실상 업계 표준.
- **패키지**: `@xterm/xterm` (코어), `@xterm/addon-webgl` (WebGL 렌더러), `@xterm/addon-canvas` (Canvas 렌더러), `@xterm/addon-fit` (크기 자동 맞춤), `@xterm/addon-unicode11` (Unicode 11 지원).

## 우리 아키텍처에서의 역할

**채택.** nexus-code의 renderer 프로세스에서 터미널 에뮬레이터로 사용. `@xterm/addon-webgl` WebGL 렌더러와 함께 구성. 워크스페이스당 다중 터미널 탭을 지원하며, PTY 실제 제어는 Electron main 프로세스의 node-pty가 담당하고 xterm.js는 렌더링과 사용자 입력 처리만 맡음(VSCode 패턴). IME 이슈 #5734는 Issue 6 한국어 체크리스트에서 선제 회피 계획 수립 완료.

## nexus-code 적용 핀 정책 (E2)

현재 코드 기준 버전:

- `@xterm/xterm`: `6.0.0`
- `@xterm/addon-webgl`: `0.19.0`
- `@xterm/addon-fit`: `0.11.0`
- `@xterm/addon-search`: `0.16.0`
- `@xterm/addon-unicode11`: `0.9.0`

운영 원칙:

1. xterm 코어/애드온은 모두 **정확 버전 pin**만 허용한다(semver range 금지).
2. 코어와 애드온은 한 번에 올린다(부분 업그레이드 금지).
3. 업그레이드 전후로 `verify:native` + `test:fonts` + 한국어 IME 게이트를 함께 확인한다.
4. 업스트림 이슈가 릴리스 블로커가 되면 fork escape-hatch runbook을 발동한다 (`pattern-xterm-fork-escape-hatch.md`).

## 성능

WebGL 렌더러(`@xterm/addon-webgl`)는 Canvas 렌더러 대비 900%+ 빠름. GPU 가속으로 대량 출력 시에도 프레임 드롭 없음.

## 알려진 구체 이슈

| 이슈 | 상태 | 내용 |
|---|---|---|
| #5734 | CLOSED (2026-04-24 확인) | IME composing 위치 오류. GitHub 이슈는 닫혔지만 현재 pinned `@xterm/xterm@6.0.0`에서 제거 가능 여부는 아직 검증하지 않았다. E2는 앱 소유 overlay로 항목 1번을 방어한다. |
| #1453 | CLOSED (2026-04-24 확인) | ambiguous width 문자 처리 이슈. 닫힌 상태지만 한글 double-width 회귀 가능성은 업그레이드 때마다 한국어 체크리스트 항목 3으로 확인한다. |
| #4753 | CLOSED (2026-04-24 확인) | Unicode11 애드온 메타데이터/폭 계산 관련 이슈. 닫힌 상태지만 E2는 `@xterm/addon-unicode11` 활성화와 항목 3 자동 게이트를 유지한다. |

**회피 전략**: #5734는 현재 닫힌 이슈지만, pinned 버전에서 제거 검증이 끝나기 전까지 composingstart/compositionupdate/compositionend 기반 앱 overlay 패치를 유지한다. 필요 시 upstream PR 추적 또는 fork 유지로 전환한다.

## 분기별 점검 루틴 (#5734 / #1453 / #4753)

분기 시작 주(1월/4월/7월/10월 첫 주)에 아래를 반복한다.

1. 세 이슈의 상태(OPEN/CLOSED), 최근 maintainer 코멘트, 연결 PR 머지 여부를 확인한다.
2. 상태 변화가 있으면 이 파일의 스냅샷 날짜와 상태 표를 갱신한다.
3. #5734가 실질적으로 해결되었으면 오버레이 패치 제거 가능성을 별도 브랜치에서 검증한다.
4. #1453 또는 #4753 변화로 한국어 체크리스트 항목 3에 영향이 보이면 즉시 회귀 테스트를 수행한다.
5. 업스트림 대응이 지연되고 릴리스 게이트를 막으면 `pattern-xterm-fork-escape-hatch.md` 절차로 전환한다.

## 우리 한국어 체크리스트와의 관계

Issue 6 릴리스 전 필수 통과 7개 항목 중 #5734 계열 동작은 항목 1번(조합 중 커서 위치)과 항목 2번(조합 중 Enter 처리)에 직결된다. 현재 pinned 버전에서는 앱 overlay/composition buffer로 방어하고, xterm 업그레이드 때만 패치 제거 가능성을 검증한다.

## 라이선스

MIT

## 출처

- https://xtermjs.org
- https://github.com/xtermjs/xterm.js
- https://github.com/xtermjs/xterm.js/issues/5734
- https://github.com/xtermjs/xterm.js/issues/1453
- https://github.com/xtermjs/xterm.js/issues/4753

## 이슈 추적 (stack.md 이관)

- 추적 대상: `#5734`, `#1453`, `#4753`
- 점검 주기: 분기 시작 주(1월·4월·7월·10월 첫 주)
- 대응 트리거: 업스트림 이슈가 릴리스 블로커가 되면 `.nexus/memory/pattern-xterm-fork-escape-hatch.md` 절차로 전환

