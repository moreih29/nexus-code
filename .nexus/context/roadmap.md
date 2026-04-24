# Roadmap

## v0.1 MVP — 5 Epics

### E1. Workspace Shell

폴더 열기로 워크스페이스를 등록하고, 사이드바 목록에서 단축키·클릭으로 즉시 전환한다.
세션은 앱 재시작 후에도 복원된다. sidecar는 기본적으로 항상 실행 상태(P1 idle 정책)를 유지한다.

### E2. Terminal Native (MVP 컷)

워크스페이스마다 **shell 전용** 다중 탭 터미널을 제공한다. MVP 포함 범위는 아래 6개로 고정한다.

1. 워크스페이스당 다중 탭 shell 터미널 (`tt_<workspaceId>_<nonce>`), 비활성 탭/워크스페이스는 `display:none`으로 유지
2. xterm.js + WebGL 렌더러 + Unicode11 애드온 기반 렌더링
3. 2층 인메모리 스크롤백(복원 없음): xterm 10,000 lines + main 8MB 링버퍼(FIFO silent drop)
4. 한국어 IME 하이브리드 대응: 오버레이(composition view 숨김) + composition buffer + 조합 중 Enter 차단
5. 기본 폰트 스택 고정: D2Coding + Noto Sans KR 번들(OFL 1.1)
6. 릴리스 게이트: 자동 게이트(네이티브 smoke + IME 자동 체크)와 수동 게이트(서명 .app Dock 실행 + 한국어 IME 실기) 모두 통과

#### E2 명시적 제외 (포스트-MVP)

- 터미널 split pane
- 터미널 프로파일 UI(쉘 프리셋/환경 프리셋)
- 터미널 테마/키바인딩 커스터마이징(Vim 모드 포함)
- direnv 앱 내 통합(사용자 shell hook 경로만 지원)
- main 링버퍼 재생(replay)·복원 UI

### E3. AI Harness Observer

claude-code, opencode, codex 세 어댑터를 동시 지원한다. IDE는 하네스의 실행 상태를 읽기 전용으로 관찰하며, 탭 뱃지, 도구 호출 사이드 패널, 파일 편집 diff 뷰, OS 알림을 통해 상황을 전달한다.

### E4. Code Editor + LSP

에디터와 언어 서버 통합을 제공한다. TypeScript, Python, Go 세 언어의 LSP를 MVP에서 지원한다.
Go는 sidecar를 직접 dogfooding하는 언어다. 파일트리, 탭 기반 파일 편집, git 상태 표시, 기본 검색·치환을 포함한다.

### E5. Preview Panel

마크다운 라이브 프리뷰를 분할 뷰로 제공한다. localhost 및 정적 URL을 웹뷰로 표시한다.

---

## 명시적 비(非)MVP

아래 항목은 v0.1 범위 밖이다. 요청이 들어와도 MVP 중에는 추가하지 않는다.

- Windows / Linux 지원
- 테마 커스터마이징
- 세팅 UI 정교화
- 국제화 (한국어 UI 번역 포함)
- 협업·공유·원격 워크스페이스
- 확장 스토어
- Vim 모드 및 키바인딩 커스터마이징

---

## 마일스톤 순서

| 단계 | 내용 |
|------|------|
| M0 Foundation | 앱 스캐폴드, sidecar 스캐폴드, IPC 계약 셋업 |
| M1 Workspace Shell | E1 완성 |
| M2 Terminal + CJK | E2 완성, 한국어 체크리스트 통과 |
| M3 Harness Observer | E3 완성 |
| M4 Editor + LSP | E4 완성 (TypeScript / Python / Go) |
| M5 Preview | E5 완성 |
| M6 v0.1 Release | 통합 테스트, CJK 회귀 검증, 초기 유저 10명 dogfood |

마일스톤은 순서대로 진행하되, M4와 M5는 M3 완료 후 병렬 착수 가능하다.

---

## 타임라인 가이드

이 수치는 강제 일정이 아니라 **방향 감각용 가이드**다.

- Full-time: 12–15개월
- Part-time: 24–30개월
- 몰아서 진행: 마일스톤 단위로만 예측 가능

sidecar를 Go로 작성하는 초기 셋업 비용은 LLM 에이전트 협업으로 실질적으로 낮아진다.

---

## 포스트-MVP 우선순위

### v0.2 (MVP 출시 후 3–6개월)

MVP에서 의도적으로 뺀 항목을 순서대로 추가한다.

1. 테마·UI 정교화 (커스터마이징, 세팅 UI)
2. 협업·공유·원격 워크스페이스 (기초)
3. 세션 비교 뷰, 워크스페이스 그룹, P2 suspend 정책 활성화

### v0.5

- Windows / Linux 지원
- 확장 API, 사용자 정의 hook

### v1.0

- 팀 공유·원격 동기화 기반 유료 기능 시그널

---

## 성공 기준 (v0.1 출시 판정)

1. 한국어 IME·렌더링 체크리스트 7개 항목 전부 통과
2. 워크스페이스 3개를 동시에 열고 전환 시 끊김 없음
3. claude-code, opencode, codex 세 하네스 모두 기본 시나리오 정상 동작
4. TypeScript, Python, Go 세 언어의 LSP 연동 확인
5. 초기 유저 10명으로부터 "일상에서 쓸 만하다" 피드백 확보
6. macOS codesign + notarized 배포 완료
