# 터미널 출력 UX 레퍼런스: Warp 패턴 분석

> 조사일: 2026-03-27
> 목적: Nexus Code GUI 터미널 출력 컴포넌트 설계를 위한 레퍼런스

---

## 1. 블록 기반 출력 구조 (Block-Based Output)

### What
명령어와 그 출력을 하나의 "블록"이라는 원자 단위로 묶어 표시. 전통적인 터미널의 무한 스크롤 텍스트 스트림 대신, 각 명령 실행이 독립적인 시각 컨테이너를 형성한다.

- 블록은 아래에서 위로 축적되며, 실패한 명령은 빨간색 배경으로 구분
- 장문 출력이 화면을 벗어날 경우 **Sticky Command Header**가 상단에 고정되어 현재 어떤 명령의 출력인지 추적 가능
- `CMD-UP/DOWN` (macOS) / `CTRL-UP/DOWN` (Linux)으로 블록 간 키보드 네비게이션
- 다중 블록 선택: `CMD/CTRL-SHIFT` 조합으로 블록 범위 선택 및 복사 가능

### Why
전통 터미널에서 출력이 섞이면 어디서 어느 명령이 끝났는지 파악이 어렵다. 블록화는 인지 부하를 줄이고, 히스토리 탐색·공유·재실행을 가능하게 한다.

### Trade-off
- 장점: 명령-출력 대응 명확, 부분 선택·공유 용이, 에러 즉시 식별
- 단점: 연속적으로 흐르는 스트리밍 출력(예: `tail -f`, 빌드 로그)에서는 블록 경계가 자연스럽지 않음. 블록이 많아지면 화면 단편화 발생

---

## 2. AI 컨텍스트 통합 (Contextual AI Integration)

### What
AI 어시스턴트를 별도 도구가 아닌 터미널 인터페이스 안에 임베드. 세 가지 진입점:

1. **자연어 명령 생성**: 입력창에 `#`를 입력 후 자연어로 설명하면 실행 가능한 명령어로 변환 (`# 지난 30분간 수정된 파일 목록` → `find . -mmin -30 -type f`)
2. **에러 설명**: 실패한 블록에서 우클릭 → "Ask Warp AI"로 에러 원인 및 해결책을 컨텍스트(현재 명령+출력)와 함께 질의
3. **에이전트 모드**: 터미널 뷰와 별도의 대화형 AI 뷰를 전환하여 멀티턴 워크플로우 수행

### Why
명령어 암기 부담을 줄이고, 에러 디버깅 흐름을 터미널 밖으로 끊지 않는다. 컨텍스트(현재 세션, 오류 출력)가 이미 존재하므로 별도 붙여넣기 없이 즉시 질의 가능.

### Trade-off
- 장점: 컨텍스트 전환 최소화, 입문자 진입장벽 낮춤, 복잡한 파이프라인 생성 보조
- 단점: AI 요청은 외부 네트워크 의존(오프라인 불가), 생성된 명령 실행 전 검증 필요, 모델 비용 발생(무료 100회/월)

---

## 3. 커맨드 팔레트 (Command Palette)

### What
`CMD-P` (macOS) / `CTRL-SHIFT-P` (Linux)로 전역 접근. IDE 스타일의 퍼지 검색으로 워크플로우, 노트북, 단축키, 설정을 단일 인터페이스에서 탐색.

접두사 필터로 검색 범위를 좁힘:

| 접두사 | 대상 |
|--------|------|
| `w:` | 저장된 워크플로우 |
| `p:` | AI 프롬프트 템플릿 |
| `n:` | 노트북 |
| `env_vars:` | 환경변수 |
| `actions:` | 설정/기능 토글 |

### Why
명령어와 설정이 많아질수록 메뉴 탐색 비용이 증가한다. 키보드 중심 접근으로 파워유저 속도를 유지하면서, 기억하지 못하는 기능도 검색으로 발견 가능.

### Trade-off
- 장점: 마우스 없이 모든 기능 접근, 점진적 학습(접두사 모르면 전체 검색), VS Code 사용자에게 친숙
- 단점: 처음 사용자는 무엇을 검색해야 할지 모름(discoverability 한계), 팔레트 내 항목이 많아지면 결과 노이즈 증가

---

## 4. 상태 표시 시스템 (Status Indication)

### What
명령 실행 상태를 블록 수준에서 즉시 시각화:

- **실행 중**: 블록 우측에 스피너/진행 애니메이션, 경과 시간 표시
- **성공**: exit code 0 — 블록 테두리 기본 색상 유지
- **실패**: exit code non-zero — 블록 배경을 빨간색으로 강조, exit code 숫자 표시
- **장시간 실행**: Sticky Header로 화면 상단에 실행 중인 명령 고정(스크롤해도 유지)

### Why
전통 터미널은 프롬프트가 돌아올 때까지 성공/실패를 알 수 없고, 오래된 에러를 찾으려면 스크롤을 올려야 한다. 상태의 즉각적 시각화는 멀티태스킹 시 현재 상황 파악을 빠르게 한다.

### Trade-off
- 장점: 에러 즉시 식별, 장시간 실행 명령 모니터링 용이, 히스토리에서 실패 명령 빠른 탐색
- 단점: 색상에만 의존하면 색맹 접근성 문제 / ANSI 색상이 많은 출력에서 블록 상태 색상이 묻힐 수 있음

---

## 5. 편집기 스타일 입력창 (Editor-Style Input)

### What
터미널 입력 영역을 IDE 텍스트 에디터처럼 구현:

- 멀티라인 편집 기본 지원 (긴 명령어를 여러 줄에 걸쳐 작성)
- 구문 강조 (명령어, 플래그, 인수 색상 구분)
- IDE 수준의 커서 이동 (`Option-LEFT/RIGHT`로 단어 단위 이동)
- 풍부한 자동완성: 명령어, 플래그, 경로, git 브랜치 등 컨텍스트 인식 제안

### Why
복잡한 명령(긴 파이프라인, 멀티라인 스크립트)은 한 줄에 입력하면 가독성이 떨어진다. 에디터 경험은 개발자의 기존 근육 기억을 활용한다.

### Trade-off
- 장점: 복잡한 명령 작성/수정 용이, 실수 줄임, 학습 곡선 완화
- 단점: 전통 터미널 동작(예: `readline` 단축키 일부 충돌)과 불일치로 파워유저 마찰 발생 가능, 텍스트 기반 렌더러와 호환성 없음

---

## 대안 터미널과의 차별점 요약

| 터미널 | 핵심 포지션 | Warp 대비 차별점 |
|--------|-------------|-----------------|
| **iTerm2** | 기능 풍부한 전통 터미널 | 분할 패널, 상태바 커스터마이징 강점. AI 없음. 블록 개념 없음 |
| **Hyper** | 웹 기술 기반 확장성 | JS/CSS 플러그인 생태계. 성능이 GPU 가속 터미널 대비 낮음 |
| **Alacritty** | 극한 성능 | Rust + GPU 렌더링으로 가장 빠름. 기능 최소주의 — AI, 블록, 팔레트 없음 |
| **Kitty** | 성능 + 확장성 균형 | GPU 가속 + 타일링 레이아웃. 설정 복잡. AI 없음 |

Warp의 핵심 차별점은 **블록 추상화 + AI 컨텍스트 통합**이며, 성능(Rust + GPU)은 기본값으로 제공하면서 생산성 레이어를 추가한 구조.

---

## Nexus Code 적용 시사점

1. **출력 블록화**: Claude Code의 각 명령/응답 단위를 블록으로 묶어 fold/expand 가능하게 구현
2. **상태 배지**: 실행 중(스피너) / 완료(체크) / 에러(X + exit code) 를 블록 헤더에 표시
3. **Sticky Header**: 긴 출력 스크롤 시 어떤 명령의 출력인지 상단 고정
4. **에러 강조**: non-zero exit code 블록은 배경색으로 즉시 구분
5. **커맨드 팔레트**: `CMD-K` 또는 `CMD-P`로 자주 쓰는 Claude Code 작업에 빠른 접근

---

*Sources:*
- [Warp Block Basics](https://docs.warp.dev/terminal/blocks/block-basics)
- [Warp Command Palette](https://docs.warp.dev/terminal/command-palette)
- [Warp AI Features](https://www.warp.dev/warp-ai)
- [Warp Modern UX](https://www.warp.dev/modern-terminal)
- [Warp vs iTerm2 Comparison](https://www.warp.dev/compare-terminal-tools/iterm2-vs-warp)
- [Terminal Emulators Compared 2026](https://thesoftwarescout.com/best-terminal-emulators-for-developers-2026-warp-iterm2-alacritty-more/)

---

## 실현성 검토 (Architect)

> 현재 아키텍처: BashRenderer + CollapsibleResult (10줄 초과 접기), stream-json으로 Bash tool_call/tool_result 수신, ANSI 미지원

### 1. 블록 기반 출력 구조

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `BashRenderer`가 이미 명령어 + 출력을 하나의 `ToolCard`로 묶는 블록 구조. 다만 블록 간 키보드 네비게이션, Sticky Header, 다중 선택은 미구현.
- **필요 사항**: (1) `ToolCard`에 블록 ID 부여 + `CMD-UP/DOWN` 키보드 네비게이션. (2) Sticky Header는 `IntersectionObserver`로 스크롤 시 현재 블록 명령어를 상단 고정. (3) 에러 블록(isError) 배경색 강조 — 현재 `ToolCard` status가 'error' 시 빨간 텍스트만 표시하므로 배경색 추가.
- **구현 난이도**: 기본 블록 강화 Low, Sticky Header Medium

### 2. AI 컨텍스트 통합

- **실현 가능성**: 높음 (이미 핵심 아키텍처)
- **기술적 제약**: 없음. Nexus Code 자체가 CLI 래퍼이므로 "AI 컨텍스트 통합"은 앱의 근본 구조. 에러 블록에서 "Ask Claude" 버튼으로 에러 내용을 다음 프롬프트에 자동 삽입하는 기능은 `ChatInput`에 프리필 메커니즘 추가로 가능.
- **필요 사항**: `BashRenderer` 에러 블록에 "에러 분석 요청" 버튼 → 클릭 시 에러 출력을 `ChatInput`에 프리필 + 자동 포커스.
- **구현 난이도**: Low

### 3. 커맨드 팔레트

- **실현 가능성**: 보통
- **기술적 제약**: 없음. Electron에서 `globalShortcut`으로 `CMD-K` 또는 `CMD-P` 바인딩 후 React 오버레이 모달로 구현 가능.
- **필요 사항**: (1) 커맨드 팔레트 React 컴포넌트 (퍼지 검색 + 항목 목록). (2) 등록 가능한 커맨드 레지스트리 (새 세션, 워크스페이스 전환, 설정, 히스토리 등). (3) `ipcMain`에 단축키 핸들러 등록.
- **구현 난이도**: Medium (새 컴포넌트 + 커맨드 레지스트리 설계)

### 4. 상태 표시 시스템

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `ToolCard`의 `resolveStatus()`가 `running | done | error`를 판별하고, 각 상태별 텍스트 표시 중. 배경색 변경, exit code 표시, 경과 시간은 UI 레벨 추가.
- **필요 사항**: (1) `BashRenderer`에 exit code 표시 (tool_result에서 파싱 또는 `isError` 플래그 활용). (2) 실행 중 경과 시간 타이머 — `ToolCard`가 running 상태일 때 `Date.now() - timestamp`로 표시. (3) 에러 블록 배경색 (`bg-red-950/20`).
- **구현 난이도**: Low

### 5. 편집기 스타일 입력창

- **실현 가능성**: 보통
- **기술적 제약**: 현재 `ChatInput`은 일반 textarea. 구문 강조와 자동완성은 코드 에디터 컴포넌트(예: `@codemirror/view`) 교체 필요. 다만 Nexus Code의 입력은 자연어 프롬프트이므로, 터미널 수준의 구문 강조보다는 멀티라인 + 자동 높이 조절이 더 중요.
- **필요 사항**: 멀티라인 자동 높이 조절은 textarea의 `scrollHeight` 기반으로 가능 (라이브러리 불필요). 슬래시 커맨드 자동완성(`/commit`, `/help` 등)은 커스텀 드롭다운으로 구현 가능.
- **구현 난이도**: 자동 높이 Low, 자동완성 Medium, 구문 강조 High (불필요할 수 있음)
