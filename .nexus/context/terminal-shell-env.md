# Terminal Shell Environment

## 목적과 범위

이 문서는 E2 shell 터미널에서 사용하는 환경변수 해석 규칙(`ShellEnvironmentResolver`)만 정의한다.
터미널 탭 spawn 시 어떤 셸/환경을 기본으로 쓰는지, 그리고 어떤 경우에 fallback 하는지를 명확히 고정한다.

---

## 기본 동작 규약

### 1) 베이스 환경은 앱 세션당 1회 캡처

- 기본 셸 경로: `SHELL`(캡처 캐시 우선, 없으면 `process.env.SHELL`) → 없으면 `/bin/zsh`
- 캡처 커맨드: `<shell> -l -i -c env`
- 타임아웃: 5초 (`5000ms`)
- 결과 파싱: 줄 단위 `KEY=VALUE`만 허용, NUL 키/비정상 라인은 버림

첫 캡처 결과는 캐시되고, 동시 요청은 in-flight Promise를 공유한다.

### 2) 실패 시 fallback

아래 경우에는 `process.env`(정제본)으로 fallback 한다.

- 캡처 타임아웃
- 셸 실행 에러
- 캡처 stdout에 파싱 가능한 엔트리가 0개

fallback 시 dev 로그를 남기고 계속 진행한다(터미널 오픈을 막지 않음).

### 3) 기본 환경값 강제/보정

- 항상 강제:
  - `TERM=xterm-256color`
  - `COLORTERM=truecolor`
- 조건부 기본값(없을 때만):
  - `LANG=en_US.UTF-8`
  - `LC_ALL=en_US.UTF-8`

즉, TERM/COLORTERM은 기존 값이 있어도 덮어쓰고, LANG/LC_ALL은 미설정(`undefined`)일 때만 채운다.

### 4) 터미널 탭 spawn 기본값

- 기본 셸 인자: `["-l", "-i"]`
- `terminal/open`에서 `shell`, `shellArgs`, `cwd`, `envOverrides`를 넘기면 기본값을 덮어쓴다.
- 넘기지 않으면 resolver 기본값으로 spawn 한다.

---

## 셸 지원 범위 (MVP)

- **공식 보장**: zsh, bash (login + interactive 경로)
- **best-effort**: fish, nushell

fish/nushell은 `-l/-i/-c` 플래그 의미가 다를 수 있어, 환경 캡처가 부분적으로만 동작할 수 있다.
이 경우에도 fallback 경로로 터미널은 열리지만, 사용자 셸 설정 반영 수준은 보장하지 않는다.

---

## direnv 정책

MVP에서 앱이 direnv를 직접 통합하거나 주입하지 않는다.
direnv는 **사용자 셸 startup hook**으로만 반영한다.

- 예: 사용자가 `.zshrc`/`.bashrc`/`config.fish`/`config.nu`에 `direnv hook ...`을 설정
- 앱은 해당 셸을 login + interactive로 띄워서 결과 환경을 읽기만 한다

즉, direnv 동작 책임은 사용자 셸 설정에 있고, 앱은 그 결과를 소비한다.

---

## 경계 선언 (E2 ↔ E3)

이 문서는 E2 shell 터미널 경계만 다룬다.
하네스 이벤트 모델, 하네스 타입 구분자(kind/discriminator), observer 계약은 이 범위에 포함하지 않는다.
