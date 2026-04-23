# external-opencode

스냅샷 날짜: 2026-04

---

## 개요

sst(Serverless Stack)가 개발한 오픈소스 TUI 기반 AI 코딩 하네스. Go로 작성, MIT 라이선스. 2026-04 기준 GitHub 95,000+ 스타.

---

## 배포 방식

- **런타임**: Go 단일 바이너리. 런타임 의존성 없음.
- **배포 경로**: GitHub Releases (공식 바이너리), Homebrew, 소스 빌드.
- **UI 프레임워크**: Bubble Tea (Go TUI 라이브러리). Vim-like 에디터 내장, LSP 통합 포함.
- **플랫폼**: macOS / Linux / Windows.

---

## 세션 저장 경로 및 포맷

- **저장소**: SQLite 데이터베이스 (세션 DB).
- **경로**: 프로젝트 디렉토리 또는 XDG 규칙 기반 데이터 디렉토리. 정확한 경로는 버전·플랫폼에 따라 다를 수 있음.
- **포맷**: SQLite. 턴 단위 행 삽입.
- **특성**: 파일 기반 DB이므로 fsnotify로 변경 감지 후 SQLite 쿼리로 신규 이벤트 조회 가능.

---

## 관찰 가능한 이벤트

**이벤트 스트림**:
- SQLite 세션 DB를 직접 쿼리해 신규 행을 폴링하거나, 파일 변경 이벤트(fsnotify)를 트리거로 사용.
- 공식 Hooks API는 2026-04 기준 claude-code 수준의 별도 훅 명세가 공개되어 있지 않음 — SQLite 관찰이 주 경로.

**관찰 접근 방식**:
1. fsnotify로 SQLite 파일 변경 감지
2. 변경 감지 시 신규 행 쿼리 (last-seen rowid 이후 SELECT)
3. 이벤트(도구 호출, 메시지, 완료 등) 행을 nexus-code 내부 이벤트로 매핑

---

## per-turn spawn + `--resume` 지원

- **단일 프로젝트·단일 세션 모델**: opencode는 프로젝트 디렉토리 기준 단일 세션으로 동작. 멀티 워크스페이스 격리 없음.
- **per-turn spawn**: 명시적 per-turn spawn 패턴의 공식 지원은 2026-04 기준 확인되지 않음. TUI 프로세스 자체가 장기 실행 형태.
- **`--resume` 동등 기능**: SQLite DB에 세션이 영속화되므로, 프로세스 재시작 후 동일 DB를 가리키면 이전 컨텍스트 유지 가능. 명시적 `--resume <sessionId>` 플래그 여부는 2026-04 기준 미확인.
- nexus-code 통합 전략: SQLite DB를 읽기 전용으로 관찰하는 Observer 패턴 적용. TUI 프로세스는 그대로 유지.

---

## 알려진 IME / 터미널 / CJK 관련 이슈

- 2026-04 기준 공식 이슈 트래커에서 CJK/IME 관련 번호가 지정된 미해결 이슈는 확인되지 않음.
- Bubble Tea 기반 TUI의 특성상 터미널 IME 처리는 호스트 터미널 에뮬레이터에 위임됨.
- nexus-code에서 opencode를 xterm.js 내에서 실행할 경우, IME 관련 이슈는 xterm.js 레이어(xtermjs/xterm.js#5734 등)에서 관리.

---

## 스키마 안정도

- **SQLite 스키마**: 세 하네스 중 가장 안정적. SQLite 특성상 스키마 마이그레이션이 명시적으로 관리되며, 열 추가·제거 이력을 마이그레이션 파일로 추적 가능.
- **변동 빈도 평가**: 낮음. 오픈소스이므로 스키마 변경이 PR을 통해 공개적으로 확인 가능.
- **어댑터 보수 부담**: 낮음. 스키마 변경 시 마이그레이션 파일을 참조해 어댑터 업데이트 가능.

---

## 라이선스

MIT

---

## 출처

- <https://opencode.ai>
- <https://github.com/sst/opencode>
