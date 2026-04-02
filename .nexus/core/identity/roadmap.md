<!-- tags: roadmap, phases, priorities, themes, settings -->
# Roadmap

---

## v1 기반 구축 (완료)

Claude Code CLI를 GUI로 래핑하는 기반 앱 구축. 기본 통신, UI, 설정, 성능 최적화까지.

| Phase | 이름 | 주요 내용 |
|-------|------|-----------|
| Phase 1 | 기반 | MVP, stream-json 통신 안정화, 코드 구조 정비 (M0+M1+M1.5) |
| Phase 2 | UI/UX | 시각 개선, 인터랙션 기초, 파일 변경 안전성, 일상 편의 (M2a+M2b+M3+M4) |
| Phase 3 | 고도화 | 퍼미션 enforcement, 체크포인트 고도화, UX 개선, 구조 변경 (M5+M6a+M6b) |
| Phase 4 | 레이아웃 | react-resizable-panels 기반 리사이저블 3패널 + 아이콘 스트립 |
| Phase 5 | 기반 정비 | Terracotta 테마 + 렌더링 성능 최적화 + 도구 블록 밀도 모드 |
| Phase 6 | 패널 고도화 | 우측 패널 자동 전환 + Nexus 타임라인 + 비용 추적 |
| Phase 7 | 테마 확장 | 6개 테마 + 테마 선택 UI + 툴 상태 버그 수정 |
| Phase 8 | 설정 고도화 | settings-store SSOT 리팩토링, SettingsModal 전면 재작성(6카테고리), 모델 빠른 전환, buildArgs --effort 확장 |

---

## v2 오케스트레이션 워크스테이션

**목표:** Claude Code의 멀티에이전트 오케스트레이션을 GUI에서 감독·검증·제어하는 워크스테이션.
**원칙:** "오케스트레이션이 아닌 것은 안 만든다" — 4대 함정 회피: IDE 재발명, 기술부채 완벽주의, 기능 추가 중독, 출시 지연.
**전체 기간:** 5~7개월

---

### Phase 1: 감독 루프 MVP — "한 화면에서 다 보인다"

**목표:** 에이전트 실행 → 사이드바 턴 클릭 → diff 확인 → 승인/거부가 끊김 없이 동작하는 최소 감독 루프.
**완료 기준:** 에이전트 실행 중 사이드바에서 턴을 클릭하면 Chat·Editor·Browser가 해당 컨텍스트로 필터링되고, diff를 확인한 뒤 승인 큐에서 승인 또는 거부할 수 있다.

#### 산출물

**1. 에이전트 사이드바**
- 기반: 현재 `ActivityBar` → Agent Sidebar로 진화. `AgentTracker` 확장 + 신규 컴포넌트.
- 내용: 에이전트별 상태 카드 (running/stopped), 경과 시간, 마지막 실행 도구, 변경 파일 수 배지.
- 의존: `AgentTracker`, `session-store`, IPC 에이전트 이벤트 스트림.

**2. 통합 승인 큐**
- 기반: `PermissionHandler` + `permission-store` 리팩토링. 현재 모달 방식 → 큐 방식 전환.
- 내용: 크로스 에이전트 권한 요청 집중 패널. 우선순위 정렬, 일괄/개별 승인, "이 에이전트 자동 승인" 설정 저장.
- 의존: `PermissionHandler`, `permission-store`, 에이전트 사이드바(에이전트 식별).

**3. 컨텍스트 바인딩**
- 기반: 신규 `context-store`. Chat·Editor·Browser 각 패널에 필터 로직 추가.
- 내용: 사이드바에서 에이전트/턴 선택 시 Chat·Editor·Browser가 해당 컨텍스트로 필터링.
- 의존: 에이전트 사이드바(선택 이벤트), `session-store`.

**4. 체크포인트 Diff View**
- 기반: `CheckpointManager` 스냅샷 간 Monaco `DiffEditor` 연동.
- 내용: 턴별 파일 변경 목록 + 인라인 diff. 컨텍스트 바인딩과 연동하여 선택 턴 자동 표시.
- 의존: `CheckpointManager`, `context-store`, Monaco Editor.

**5. 감독 워크플로우 키보드 단축키** _(Phase 1 후반)_
- 내용: 승인 큐 승인/거부, 다음 에이전트 턴 이동 등 핵심 감독 액션 단축키 바인딩.
- 의존: 위 1~4 산출물 완성 후 적용.

---

### Phase 2: 검증 도구 완성 — "알아서 보여준다"

**목표:** 도구 상세·Mission Control로 에이전트 작업을 전방위 검증.
**완료 기준:** 파일 탐색기에서 에이전트 수정 파일 한눈에 식별, 도구 상세 펼쳐서 입출력 전문 확인, Mission Control 대시보드에서 전체 오케스트레이션 상태 조망.
**의존:** Phase 1 (컨텍스트 바인딩, 에이전트 사이드바) 완료 후 착수.

#### 산출물

**1. 에이전트 변경 파일 목록**
- 기반: `context-store` + `CheckpointManager`.
- 내용: 에이전트가 수정/생성/삭제한 파일을 플랫 리스트로 표시. 변경 유형 색상 구분. 클릭 → 에디터 diff 연동. 전체 프로젝트 파일 트리는 VS Code/Finder에 위임.
- 의존: `context-store` (에이전트 수정 파일 목록), `CheckpointManager`.

**2. 도구 실행 상세 뷰**
- 기반: 기존 `ToolRenderer` 확장.
- 내용: 도구 입력/출력 전문 토글. JSON·코드 구문 강조. 대용량 출력 접기/펼치기.
- 의존: `ToolRenderer`, `session-store` 도구 이벤트.

**3. Mission Control 대시보드**
- 기반: 신규 `OrchestrationMap` 컴포넌트. 기존 `GanttTimeline` 연동.
- 내용: 에이전트 트리를 노드 그래프로 시각화. 각 노드에 상태·진행률 배지. 노드 클릭 → 에이전트 사이드바 컨텍스트 연동.
- 의존: `AgentTracker`, `GanttTimeline`.

**4. Gantt 타임라인 고도화**
- 기반: 기존 `GanttTimeline.tsx` 확장.
- 내용: 병렬 에이전트 레인 표시, 도구 실행 구간 색상 구분, 줌/스크롤, 이벤트 마커 (승인 요청, 체크포인트 등).
- 의존: `AgentTracker`, `session-store` 이벤트 스트림.

**5. 시스템 트레이 알림**
- 내용: 에이전트 완료·오류·승인 요청 발생 시 시스템 트레이 알림. Electron `Notification` API.
- 의존: `AgentTracker`, `permission-store`.

**6. 세션 히스토리 전문 검색**
- 내용: 저장된 세션 로그에서 키워드·도구명·에이전트명 전문 검색. 결과 클릭 → 해당 턴 컨텍스트 전환.
- 의존: `session-store`, `context-store`.

---

### Phase 3: 워크플로우 — "전체 그림이 보인다"

**목표:** [meet] → GUI 토론 시각화 → 결정 기록 → [run] 실행 전환이 GUI 내에서 완결.
**완료 기준:** `[meet]` 태그 입력 시 GUI에서 에이전트 소집, 토론 패널 시각화, `[d]` 결정 기록, `[run]` 실행 전환이 앱 이탈 없이 동작.
**의존:** Phase 2 (Mission Control) 완료 후 착수.

#### 산출물

**1. 미팅 워크플로우 GUI**
- 기반: Mission Control 위에서 동작. 신규 `MeetingView`, `AgentDiscussionPanel` 컴포넌트.
- 내용: `[meet]` → 에이전트 소집 UI → 에이전트별 발언 패널(토론 뷰) → `[d]` 결정 기록 → `[run]` 실행 전환.
- 의존: `OrchestrationMap`, `context-store`, `AgentTracker`.

**2. 에이전트 그룹핑**
- 기반: `AgentTracker` 확장, AgentSidebar UI.
- 내용: 관련 에이전트를 미션 단위로 묶어 관리. Agent Sidebar에서 그룹 접기/펼치기. 그룹별 승인 정책.
- 의존: `AgentTracker`, 승인 큐.

---

### Phase 4: 백엔드 진화 — "CLI 한계를 넘어선다"

**목표:** CLI 의존을 추상화하고 API 직접 호출 백엔드를 추가. 설정에서 백엔드 전환 가능.
**완료 기준:** 설정에서 CLI/API 백엔드 전환 가능. API 모드에서 토큰·컨텍스트 실시간 표시.
**의존:** Phase 3 완료 후 착수. Anthropic SDK 추가.

#### 산출물

**1. AgentBackend 추상화**
- 기반: `RunManager`를 `AgentBackend` 인터페이스 뒤로 분리. `CliBackend` 구현체로 현재 동작 유지.
- 내용: 백엔드 인터페이스 정의 (start, stop, sendMessage, onEvent). 기존 CLI 동작을 `CliBackend`로 캡슐화.
- 의존: `RunManager`, `AgentTracker`.

**2. API 직접 호출 백엔드**
- 기반: `ApiBackend` 신규 구현체. Anthropic SDK (`@anthropic-ai/sdk`) 사용.
- 내용: Claude API 직접 호출, 자체 도구 실행 루프. 최소 도구 세트 직접 구현: Read, Edit, Bash, Glob, Grep.
- 의존: `AgentBackend` 인터페이스 완성.

**3. 토큰·컨텍스트 시각화**
- 기반: `ApiBackend` usage 이벤트 → 신규 `TokenUsageBar` 컴포넌트.
- 내용: 컨텍스트 윈도우 사용률 바, 턴별 토큰 비용 실시간 표시. 우측 패널 또는 상태바 통합.
- 의존: `ApiBackend`, 우측 패널 탭 시스템.

---

### Phase 5: 안정화 + 최적화 — "믿고 쓸 수 있다"

**목표:** 대형 세션 성능, 에러 복구, 배포 파이프라인, 테스트 커버리지 완성.
**완료 기준:** 1,000턴 이상 세션에서 타임라인·채팅 지연 없음. auto-update 배포 파이프라인 동작. Playwright E2E 커버리지 핵심 플로우 80% 이상.
**의존:** Phase 4 완료 후 착수.

#### 산출물

**1. 대형 세션 성능**
- 타임라인·채팅 가상 스크롤 (`react-window` 또는 자체 구현).
- diff 레이지 로딩 — 뷰포트 진입 시 Monaco DiffEditor 마운트.
- `AgentTracker` 메모리 정리 — 오래된 턴 데이터 압축.

**2. 에러 복구**
- CLI 크래시 자동 재시작 고도화 (지수 백오프, 최대 재시도).
- API rate limit / retry 로직 (`ApiBackend`).
- 네트워크 끊김 감지 및 재연결 UX.

**3. 배포 파이프라인**
- `electron-builder` auto-update 설정.
- macOS/Windows 코드 서명.
- GitHub Actions CI/CD — 빌드·테스트·릴리스 자동화.

**4. E2E 테스트**
- Playwright 커버리지 확대 — 감독 루프, 승인 큐, 체크포인트 diff, 터미널 핵심 플로우.

---

## 후속 과제 (미확정)

- **내장 터미널** — xterm.js + node-pty, 워크스페이스 cwd 연동
- **멀티워크스페이스 고도화** — 워크스페이스 간 에이전트 공유, 세션 비교, 설정 독립화
- **파일 탐색기** — 전체 프로젝트 파일 트리 (현재는 에이전트 변경 파일 목록으로 대체)
- **체크포인트 되돌리기** — CLI 컨텍스트 잔존 문제 해결
- **MCP 서버 관리 UI** — settings 패널 내 MCP 탭
- **hooks 편집기** — PreToolUse/PostToolUse 훅 설정 GUI
- **Replay** — 세션 로그 기반 사후 재생
- **프롬프트 템플릿** — 재사용 가능한 프롬프트 저장/관리
- **원격 에이전트** — 경량 데몬 + WebSocket

---

## 테마 목록

| 이름 | 컨셉 | 상태 |
|------|------|------|
| Terracotta | 따뜻한 다크 + 오렌지 강조 (기본) | 완료 (v1 Phase 5) |
| GitHub Dark | 무채색 + 파란 강조 (실제 GitHub 팔레트) | 완료 (v1 Phase 7) |
| Amethyst | 보라 틴트 + 퍼플 강조 | 완료 (v1 Phase 7) |
| Rosé Pine | 핑크/로즈 + 라벤더 | 완료 (v1 Phase 7) |
| Nord | 북유럽 블루그레이 + 시안 | 완료 (v1 Phase 7) |
| Midnight Green | 네이비 + 녹색 | 완료 (v1 Phase 7) |
