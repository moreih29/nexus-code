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
6. E2 완료 게이트: 자동 게이트(네이티브 smoke + IME 자동 체크) + 단위 테스트까지. 서명 .app 관련 수동 게이트는 로드맵 범위 외다.

#### E2 명시적 제외 (포스트-MVP)

- 터미널 split pane
- 터미널 프로파일 UI(쉘 프리셋/환경 프리셋)
- 터미널 테마/키바인딩 커스터마이징(Vim 모드 포함)
- direnv 앱 내 통합(사용자 shell hook 경로만 지원)
- main 링버퍼 재생(replay)·복원 UI

### E3. AI Harness Observer

claude-code, opencode, codex 세 어댑터를 동시 지원한다. IDE는 하네스의 실행 상태를 읽기 전용으로 관찰하며, 워크스페이스 상태 뱃지, 도구 호출 사이드 패널, 파일 편집 diff 뷰, OS 알림, 세션 히스토리 읽기 전용 뷰어(미니멀)를 통해 상황을 전달한다. 명시 제외: tool 호출 승인 주입, adapter-specific 커스텀 UX, 워크스페이스 상태 뱃지 애니메이션·rich OS 알림, 워크스페이스당 복수 하네스, 세션 히스토리 검색·필터·비교. 수평 제약: diff 뷰 패널은 E5 preview 패널과 우측 공유 컨테이너의 탭으로 공존. 성공 기준에 **sidecar WebSocket이 하네스당 최소 30분 연속 동작에서 이벤트 누락 없음(릴리스 블로커)**을 포함.

현재 구현 상태: `HarnessAdapter` 경계는 제품 코어에 고정되어 있고, claude-code 어댑터가 해당 경계 안에 구현되어 있다. opencode와 codex 어댑터는 같은 plugin boundary 안에서 후속 구현한다.

### E4. Code Editor + LSP

에디터와 언어 서버 통합을 제공한다. TypeScript, Python, Go 세 언어에서 Tier-1 9개 LSP 기능(completion/snippets, hover, go-to-definition, references, rename, formatting, signature help, code action, document symbols)을 MVP 단일 슬라이스로 지원한다. 파일트리(미니멀: expand/collapse·open·생성/삭제/이름변경·watch 반영), 탭 기반 파일 편집(close·수정됨 표시·save), git 파일 레벨 뱃지(modified/untracked/staged 등), in-file 검색·치환(Ctrl+F/Ctrl+H)을 포함한다. Workspace 표면은 Workspace strip + Filetree column으로 재구성하고, Center는 editor/terminal split을 기본으로 하며, Editor는 1-depth horizontal split을 지원한다. 명시 제외: Monaco 테마·키바인딩·폰트 커스텀 UI, project-wide 검색, 전용 git UI, debugger·test runner·extension·marketplace, 자체 AI 인라인 제안. 수평 제약: Phase A의 React 셸이 "Workspace strip + Filetree column + 중앙(에디터/터미널) + 우 보조 공유 컨테이너"의 4열 layout container를 미리 비워 두고 E4에서 채움.

클라이언트 전략은 `vscode-languageserver-protocol`을 표준 LSP 타입과 JSON-RPC 메시지 기준으로 쓰고, Monaco에는 자체 provider를 능력별로 붙이는 방식으로 고정한다. sidecar는 언어 서버 프로세스 spawn/supervision/restart와 WebSocket stdio relay를 소유한다. main은 LSP protocol 처리와 Monaco integration을 맡고, renderer는 preload editor API를 통해 호출하는 하이브리드 구조를 유지한다.

### E5. Preview Panel

마크다운 라이브 프리뷰(CommonMark + GFM, rehype-highlight)를 우측 공유 패널의 탭으로 라이브 표시하고, localhost/정적 URL을 `sandbox: true` WebContentsView로 표시한다. 명시 제외: KaTeX, Mermaid, 사용자 정의 plugin, HTML/PDF 내보내기, 개발 서버 자동 감지, 다중 preview 탭, preview 전용 devtools·쿠키/세션 관리 UI. 외부 링크 클릭은 OS 기본 브라우저로 open하고 renderer 내부 이동을 차단한다.

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
| M1 Workspace Shell | E1 완성 (단위 테스트 레벨) |
| M2 Terminal + CJK | E2 완성 (자동 게이트 + 단위 테스트) |
| **Phase A — Runnable Shell 확정** | M0 잔여분(번들러·entry·preload·Go sidecar 실체) + E1/E2 실기 통합. unsigned dev launch로 3워크스페이스 열기/닫기·전환·다중 탭·IME 수동 확인·재시작 복원 통과. 4열 layout container(Workspace strip + Filetree column + 중앙 + 우 공유 보조)를 빈 슬롯으로 미리 배치해 E3·E4·E5 확장을 수용. 서명·notarize·package:mac는 로드맵 범위 외다. |
| M3 Harness Observer | E3 완성. 착수 기반은 schema↔TS/Go 계약, CI drift gate, sidecar lifecycle WebSocket handshake, WebSocket facade로 구성한다. claude-code 어댑터 1종, WorkspaceSidebar 워크스페이스 상태 뱃지, Right Shared Panel Tool live feed는 구현된 기준선이다. opencode·codex 어댑터, diff 뷰, OS 알림, 세션 히스토리는 후속 표면으로 남긴다. |
| M4 Editor + LSP | E4 격상 완료 (Tier-1 9 LSP + Workspace strip/Filetree column 재구성 + Center split + Editor 1-depth split + 디자인 폴리시) |
| M5 Preview | E5 완성 |
| M6 v0.1 Release | (1) 통합 regression smoke — 3워크스페이스 × 3하네스 × 9 LSP capability × 3언어 × Center split × Editor split × markdown+WebContentsView preview 동시 30분+ 안정성, (2) CJK 전면 회귀 — E3/E4/E5 신규 UI(워크스페이스 상태 뱃지·tool 패널·세션 히스토리·Workspace strip·Filetree column·Center split·Editor split·Maximize 상태·신규 단축키 IME 보호·preview)에서 한국어 렌더링·IME·경로 처리 체크리스트 재실행, (3) Migration gate — CenterWorkbenchMode와 EditorStore paneId 마이그레이션 단위테스트/첫 실행 검증, (4) LSP stability gate — 9 capability × 3언어 장시간 회귀, crash 자동 restart ≤5초, WebSocket relay 누락 0, 좀비 프로세스 0, (5) 10 dogfood 유저 피드백 — 4축 설문(안정성·체감 속도·IME 품질·기본 기능 만족도). 10명 섭외는 M5 시점부터 선행 착수(수집 2–4주). |

마일스톤은 순서대로 진행하되, M4와 M5는 M3 완료 후 병렬 착수 가능하다. Phase A는 M2 완료 이후 M3 착수 이전의 필수 중간 단계로 고정한다. 기간은 월 단위 가이드가 아니라 마일스톤 단위로 판단한다.

---

## 포스트-MVP 우선순위

### v0.2 (MVP 출시 후)

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

1. 한국어 IME·렌더링 체크리스트 7개 항목 전부 통과.
2. 워크스페이스 3개를 동시에 열고 전환 시 끊김 없음.
3. claude-code, opencode, codex 세 하네스 모두 기본 시나리오 정상 동작 — M6 WebSocket 30분+ 연속 안정성 재실증
4. TypeScript, Python, Go 세 언어의 Tier-1 9개 LSP 기능 기본 시나리오 정상 동작.
5. 초기 유저 10명으로부터 "일상에서 쓸 만하다" 피드백 확보 — M6 전용 게이트, 기준선 수치는 M6 진입 plan에서 결정
6. 9 LSP capability × 3언어 풀 매트릭스에서 30+분 연속 동작 회귀 없음 + LSP 서버 crash 시 sidecar 자동 restart ≤5초 복구.
7. Center split / Editor split / maximize 토글 50+회 후 mount-stable 보존 — 터미널 스크롤백 유지, Monaco model leak 0, xterm fit error 0.
