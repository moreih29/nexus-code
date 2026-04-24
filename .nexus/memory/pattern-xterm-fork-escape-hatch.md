# pattern-xterm-fork-escape-hatch

업스트림 xterm.js 이슈가 E2 릴리스 게이트를 막을 때, 조직 포크로 안전하게 전환하는 비상 패턴이다.

## 발동 조건

아래 중 하나라도 충족하면 발동한다.

- `#5734`, `#1453`, `#4753` 관련 결함이 한국어 체크리스트 또는 터미널 안정성 게이트를 블로킹한다.
- 업스트림에 수정 PR은 있으나 릴리스 일정이 우리 릴리스 일정보다 늦다.
- 업스트림 회귀로 현재 pin 버전 유지가 불가능하다.

## 원칙

1. **최소 패치**: 포크는 블로커 해소에 필요한 diff만 유지한다.
2. **정확 버전 pin 유지**: 포크 전환 후에도 semver range를 쓰지 않는다.
3. **가역성 보장**: 언제든 upstream으로 되돌릴 수 있게 변경 지점을 제한한다.

## 실행 런북

### 0) 기준선 고정

`packages/app/package.json`의 현재 xterm 계열 버전을 기록한다.

- `@xterm/xterm` 6.0.0
- `@xterm/addon-webgl` 0.19.0
- `@xterm/addon-fit` 0.11.0
- `@xterm/addon-search` 0.16.0
- `@xterm/addon-unicode11` 0.9.0

### 1) 포크 패키지 준비

1. 조직 fork 저장소를 upstream 해당 태그에서 분기한다.
2. 블로커 패치를 적용한다.
3. fork 패키지를 조직 scope로 publish 한다(예: `@<org>/xterm`, `@<org>/addon-webgl` ...).
4. 버전은 upstream + 조직 suffix(예: `6.0.0-nx.1`)로 관리한다.

### 2) 앱 의존성 전환

`packages/app/package.json`에서 xterm 계열을 fork 패키지로 교체한다.

예시(실제 org scope로 치환):

- `"@xterm/xterm": "npm:@<org>/xterm@6.0.0-nx.1"`
- `"@xterm/addon-webgl": "npm:@<org>/addon-webgl@0.19.0-nx.1"`
- 나머지 애드온도 동일 패턴으로 교체

그 뒤 lockfile을 갱신한다.

- `cd packages/app && bun install`

### 3) 검증 게이트

전환 직후 아래를 모두 통과해야 한다.

1. `cd packages/app && bun run verify:native`
2. `cd packages/app && bun run test:fonts`
3. `cd packages/app && bun test ./src/renderer/xterm-ime-overlay.test.ts ./src/renderer/xterm-view.test.ts`
4. 수동 게이트: 서명 `.app` Dock 실행 + 한국어 IME 체크리스트 실기

하나라도 실패하면 포크 버전 롤백 또는 포크 패치 수정 후 재검증한다.

### 4) 문서 동기화

포크 전환이 확정되면 다음 문서를 같은 PR에서 함께 갱신한다.

- `.nexus/memory/external-xterm-js.md` (전환 사유, 포크 버전, 점검 날짜)
- `.nexus/context/stack.md` (현재 pin 버전)
- 필요 시 `.nexus/context/roadmap.md` (릴리스 게이트 영향)

## 롤백 절차

1. `packages/app/package.json`을 upstream pin으로 되돌린다.
2. `cd packages/app && bun install`로 lockfile을 재생성한다.
3. 동일 검증 게이트(`verify:native`, `test:fonts`, IME 테스트, 수동 게이트)를 다시 통과시킨다.

## 종료 조건

업스트림이 블로커를 해결하고 공식 릴리스를 배포했으며, upstream 복귀 후 게이트가 모두 통과하면 포크 패치는 종료한다.
