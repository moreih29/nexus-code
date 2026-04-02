# Nexus Code UI 재설계 상세 설계서

> **미팅 ID:** 2  
> **일자:** 2026-04-01  
> **참석자:** 리드, 디자이너, 아키텍트  
> **브랜치:** feat/design-redesign  

---

## 목차

1. [설계 철학 및 목표](#1-설계-철학-및-목표)
2. [안건 1: 전체 레이아웃 구조](#2-안건-1-전체-레이아웃-구조)
3. [안건 2: 코드 에디터 통합](#3-안건-2-코드-에디터-통합)
4. [안건 3: 다중 워크스페이스/세션](#4-안건-3-다중-워크스페이스세션)
5. [안건 4: 에이전트 시각화](#5-안건-4-에이전트-시각화)
6. [안건 5: 내장 브라우저](#6-안건-5-내장-브라우저)
7. [안건 6: 마크다운 렌더링](#7-안건-6-마크다운-렌더링)
8. [컴포넌트 마이그레이션 맵](#8-컴포넌트-마이그레이션-맵)
9. [신규 타입 정의](#9-신규-타입-정의)
10. [목업 데이터](#10-목업-데이터)
11. [구현 Phase 로드맵](#11-구현-phase-로드맵)
12. [기술적 제약 및 주의사항](#12-기술적-제약-및-주의사항)

---

## 1. 설계 철학 및 목표

### 핵심 원칙

**"워크스페이스 = 독립된 작업 단위, 패널 = 자유 조합"**

- 모든 패널(Chat, Editor, Browser)을 **동등한 1급 시민**으로 취급
- 채팅 종속 구조(현재) → 패널 동등 구조(목표)로 전환
- 사용자가 패널을 자유롭게 배치·분할·토글

### 재설계 목표

| # | 목표 | 현재 상태 |
|---|------|----------|
| 1 | VSCode급 코드 편집 (Monaco Editor) | 없음 |
| 2 | 마크다운 실시간 프리뷰 | MarkdownViewer(RightPanel 탭)만 존재 |
| 3 | 내장 브라우저 + DevTools | 없음 |
| 4 | 다중 워크스페이스 동시 작업 | 단일 active 워크스페이스만 지원 |
| 5 | 에이전트팀/서브에이전트 시각화 | AgentTimeline(RightPanel 탭)만 존재 |

### VSCode와의 차별점

- VSCode = 단일 워크스페이스 앱. Nexus = **다중 워크스페이스 동시 작업**
- VSCode = 코드 중심. Nexus = **AI 에이전트 대화 + 코드 + 브라우저 통합**
- 에이전트팀 구조, 실행 상태, 메시지 흐름의 시각적 표현

---

## 2. 안건 1: 전체 레이아웃 구조

### 결정: 자유 패널 그리드

현재 3패널 고정 구조(Sidebar 18% - ChatPanel - RightPanel 25%)를 폐기하고, **Activity Bar + 유동 패널 그리드**로 전환한다.

### 최종 레이아웃

```
단일 워크스페이스 모드:
┌──────┬───────────────────────────────────────────────────┐
│ Act  │  Panel Grid (자유 분할)                            │
│ Bar  │                                                   │
│ 44px │  ┌─ Panel Tab Bar ──────────────────────────────┐ │
│      │  │ [Chat ✕] [handler.ts ✕] [Browser ✕]  [+]    │ │
│ [N]  │  ├──────────────────────────────────────────────┤ │
│ ──── │  │                                              │ │
│ [●]  │  │  사용자가 자유롭게 수평/수직 분할              │ │
│ [◉]  │  │  Chat, Editor, Browser, Preview 등            │ │
│ [○]  │  │  react-resizable-panels 중첩 Group 활용       │ │
│ [+]  │  │                                              │ │
│ ──── │  └──────────────────────────────────────────────┘ │
│ [탐] │                                                   │
│ [에] │  ┌─ Bottom Panel (Cmd+J 토글) ─────────────────┐ │
│ [설] │  │ [Timeline] [Terminal] [Problems]              │ │
│      │  │  에이전트 간트 차트 / 터미널 / 문제 목록       │ │
│      │  └──────────────────────────────────────────────┘ │
├──────┴───────────────────────────────────────────────────┤
│ Status Bar: [nexus-code ●] [my-api ◉]  | opus | 1.2k    │
└──────────────────────────────────────────────────────────┘

분할 뷰 모드 (별도 상단 탭 바 없음 — Activity Bar 아이콘으로만 표시):
┌──────┬──────── nexus-code ──────┬──────── my-api ────────┐
│ Act  │ [Chat] [Editor]          │ [Chat]                 │
│ Bar  │ ...                      │ ...                    │
│      │                          │                        │
│ [●◀] │                          │                        │
│ [◉]  │                          │                        │
└──────┴──────────────────────────┴────────────────────────┘
※ 분할 영역 상단에 워크스페이스 이름 바(24px) 표시
※ Activity Bar에서 분할 중인 워크스페이스는 ◀ 마커로 표시
```

### Activity Bar (좌측 44px 고정)

위에서 아래 순서:

| 위치 | 아이콘 | 기능 |
|------|--------|------|
| 상단 | `[N]` | Nexus 로고 |
| 구분선 | `────` | — |
| 중단 | 워크스페이스 이니셜 아이콘들 | 워크스페이스 전환 + 상태 dot |
| | `[+]` | 워크스페이스 추가 |
| 구분선 | `────` | — |
| 하단 | `[탐]` | 파일 탐색기 (플라이아웃) |
| | `[에]` | 에이전트 뷰 (플라이아웃) |
| | `[설]` | 설정 |

**플라이아웃 패턴:**
- Activity Bar 아이콘 클릭 시 우측으로 오버레이 패널(240px) 슬라이드
- 플라이아웃 바깥 클릭 시 닫힘
- 클릭으로 pin 가능 (Activity Bar 옆에 고정)
- 현재 Sidebar expanded 상태의 콘텐츠를 플라이아웃으로 이동

### Panel Grid 시스템

**기반 라이브러리:** `react-resizable-panels` (현재 사용 중, 유지)

**패널 타입 레지스트리:**

```typescript
type PanelType = 'chat' | 'editor' | 'browser' | 'markdown-preview' | 'timeline'

interface PanelConfig {
  id: string
  type: PanelType
  props: Record<string, unknown>  // 패널 타입별 props (파일 경로, URL 등)
}
```

**분할 규칙:**
- 수평/수직 중첩 Group으로 자유 분할
- `Cmd+\` — 현재 패널을 좌우 분할
- 패널 탭을 드래그하여 다른 위치로 이동
- 최소 크기: 각 패널 200px
- 더블클릭으로 패널 최대화/복원

### Panel Tab Bar (패널 영역 상단 36px)

```
┌─ Panel Tab Bar ──────────────────────────────────────────┐
│ [Chat ✕] [handler.ts ●] [utils.ts] [Browser ✕]  [+]    │
└──────────────────────────────────────────────────────────┘
```

- 분할된 각 패널 그룹마다 독립 탭 바
- 탭 드래그로 그룹 간 이동
- `●` dirty 표시, `✕` 닫기 (hover 시)
- `[+]` 새 패널 추가 드롭다운 (Chat/Editor/Browser/Preview)

### Bottom Panel (하단, Cmd+J 토글)

- 기본 높이: 전체의 30%
- 탭: Timeline, Terminal, Problems
- 드래그로 높이 조절
- 완전히 접을 수 있음

**Terminal 탭 범위 정의:** Claude CLI의 `Bash` 도구 출력을 표시하는 읽기 전용 로그 뷰. 독립 터미널 에뮬레이터(`xterm.js` 등)가 아님. 사용자가 직접 명령을 입력하는 인터랙티브 터미널은 향후 확장 사항 (Phase 로드맵 범위 밖). 첫 버전에서는 Bash 도구 호출의 명령어 + 출력을 시간순으로 표시하는 로그 패널.

### 활성 패널 시각적 피드백

- 포커스된 패널의 탭 바: 상단 2px primary 보더
- 비활성 패널의 탭 바: dimmed (opacity 또는 배경색 차이)
- 패널 클릭 시 포커스 전환 + `focusedWorkspace` / `focusedPanel` 상태 업데이트

### Status Bar (최하단 24px)

```
┌──────────────────────────────────────────────────────────┐
│ [nexus-code ●] [my-api ◉]  | claude-opus-4-6 | 토큰: 1.2k │
└──────────────────────────────────────────────────────────┘
```

- **글로벌 Status Bar**: 모든 활성 워크스페이스의 상태 요약 + 포커스 워크스페이스 모델/토큰
- 클릭 시 해당 워크스페이스로 전환
- **기존 `chat/StatusBar.tsx`와의 관계**: 기존 StatusBar는 Chat 패널 내부에 유지 (세션 상태, 비용, 입출력 토큰 등 상세 정보). 글로벌 Status Bar는 워크스페이스 전환 + 요약만 표시. 중복 정보 없음.
- 글로벌 Status Bar의 신규 파일: `src/renderer/components/layout/GlobalStatusBar.tsx` (기존 `chat/StatusBar.tsx`와 이름 충돌 방지)

### 기본 프리셋 레이아웃

사용자가 처음 앱을 열 때 기본 배치:

```
프리셋 1: Chat Only (기본)
┌──┬──────────────────────────────┐
│AB│         Chat Panel            │
│  │    (max-width: 800px 중앙)    │
└──┴──────────────────────────────┘

프리셋 2: Chat + Editor (파일 변경 발생 시)
┌──┬──────────────┬───────────────┐
│AB│  Chat (45%)  │ Editor (55%)  │
└──┴──────────────┴───────────────┘

프리셋 3: Full Stack (브라우저 포함)
┌──┬──────────┬──────────┬────────┐
│AB│Chat (35%)│Edit (35%)│Brw(30%)│
└──┴──────────┴──────────┴────────┘
```

### 키보드 단축키

| 단축키 | 동작 |
|--------|------|
| `Cmd+1/2/3...` | 워크스페이스 탭 전환 |
| `Cmd+E` | 에디터 패널 토글 |
| `Cmd+B` | Activity Bar 플라이아웃 토글 |
| `Cmd+J` | Bottom Panel 토글 |
| `Cmd+Shift+B` | 브라우저 패널 토글 |
| `Cmd+\` | 현재 패널 좌우 분할 |
| `Cmd+K` | 커맨드 팔레트 (현재와 동일) |
| `Cmd+Shift+D` | 도구 밀도 전환 (현재와 동일) |
| `Escape` | Monaco → Chat 포커스 전환 |

### 구현 시 삭제/변경 대상

| 현재 파일 | 변경 |
|----------|------|
| `src/renderer/components/layout/AppLayout.tsx` | **전면 재작성** — 3패널 고정 → 패널 그리드 시스템 |
| `src/renderer/components/layout/Sidebar.tsx` | **재작성** → `ActivityBar.tsx` + `FlyoutPanel.tsx` |
| `src/renderer/components/layout/MainPanel.tsx` | **삭제** — ChatPanel이 패널 그리드의 일반 패널로 |
| `src/renderer/components/layout/RightPanel.tsx` | **삭제** — 각 탭이 독립 패널 또는 다른 위치로 이동 |

---

## 3. 안건 2: 코드 에디터 통합

### 결정: 자유 배치, 기본 프리셋 Chat좌+Editor우

### Monaco Editor 통합

**패키지:** `@monaco-editor/react`

**인스턴스 전략: 단일 인스턴스 + 모델 전환 (VSCode 패턴)**

```
Monaco Editor Instance (1개)
  ├── ITextModel: handler.ts    ← setModel()로 전환
  ├── ITextModel: utils.ts
  ├── ITextModel: README.md
  └── ITextModel: types.ts

※ 분할 뷰(side-by-side) 시에만 2번째 인스턴스 생성
※ 에디터 패널을 2개 배치하면 인스턴스 2개까지 허용
```

**인스턴스당 메모리:** ~30-50MB. 모델(파일 버퍼)만 ~1MB/파일.

**필수 옵션:**
```typescript
<MonacoEditor
  options={{
    automaticLayout: true,  // ResizeObserver 기반 자동 리사이즈 — 필수
    theme: 'nexus-dark',     // 앱 테마와 동기화
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
  }}
/>
```

### 에디터 파일 탭 바 (에디터 영역 최상단 36px)

```
┌─ 파일 탭 바 ──────────────────────────────────────────┐
│ [handler.ts ●] [utils.ts] [README.md ◇]  ...   [✕]  │
└───────────────────────────────────────────────────────┘
```

**탭 상태 인디케이터:**
- `●` 수정됨 (dirty) — 주황색 dot
- `◇` 임시 탭 (코드블록에서 열림) — 이탤릭 파일명
- 일반 탭 — 닫기 버튼(✕) hover 시만 표시
- 활성 탭: 하단 2px primary 보더
- overflow: 좌우 스크롤 + 드롭다운 목록 버튼

### 에디터 자동 열림 규칙

| 이벤트 | 에디터 동작 | 조건 |
|--------|-----------|------|
| **Edit 도구** (tool_result 성공) | 해당 파일 탭 열기 + diff 하이라이트 | 에디터 숨김이면 슬라이드 인 (300ms ease) |
| **Write 도구** (새 파일) | 해당 파일 탭 열기 (일반 뷰) | 동일 |
| **Read 도구** | 탭 전환만 | 에디터가 이미 열려있는 경우에만 |
| `Cmd+E` | 에디터 토글 | 항상 |
| 코드블록 [에디터] 클릭 | 임시 탭으로 열기 | 에디터 숨김이면 슬라이드 인 |

**핵심 규칙:**
- `tool_result`까지 기다린 후 반영 (tool_call 시점은 아직 실행 전)
- 도구 실행 중: 에디터에 "적용 중..." 스피너
- 실패 시: 에디터를 열지 않고 채팅에 에러만 표시
- diff 하이라이트: 변경 라인 배경색 + 좌측 거터 마커, 3초 후 fade out

### Edit 도구 → 에디터 연동 IPC 흐름

```
[CLI tool_call: name="Edit", input={file_path, old_string, new_string}]
  → RunManager → 'tool_call' IPC 이벤트 (sessionId 포함)
  → renderer SessionStore에서 이벤트 수신
  ↓
[CLI tool_result: success]
  → RunManager → 'tool_result' IPC 이벤트
  → SessionStore에서 성공 확인
  → input에서 file_path 추출
  → 에디터: 파일 열기 or 탭 전환
  → Monaco DiffEditor로 old_string → new_string 변경 표시
```

**에디터 상태 관리:**
- 기존 `PluginStore`의 패널 데이터 구조를 활용하거나, `SessionStore`에 `openFiles` 상태 추가
- 새 스토어 생성 불필요

### 코드블록 → 에디터 연동

현재 `CodeBlock.tsx`에 [에디터] 버튼 추가:

```
┌─ typescript ────────────── [에디터] [복사] ─┐
│  function handleRequest() {                │
│    const data = await fetch(url)           │
│    return data.json()                      │
│  }                                         │
└────────────────────────────────────────────┘
```

**(A) 파일 경로가 있는 코드블록** (Edit/Write 도구 결과):
- 에디터에서 해당 파일 열기, 변경 라인으로 스크롤
- 아이콘: `ExternalLink` (lucide)

**(B) 파일 경로 없는 코드블록** (인라인 코드):
- "임시 파일"로 에디터에 열기 (탭명: `snippet-1.ts`)
- 사용자가 "다른 이름으로 저장" 가능

### 포커스 관리

- Monaco가 키보드 이벤트를 aggressively capture하므로 분리 필요
- `Escape`로 Monaco 포커스 해제 → Chat 포커스 이동
- ChatInput 포커스 시 Monaco 키바인딩 비활성화
- `Cmd+K` (커맨드 팔레트) 등 앱 전역 단축키는 Monaco보다 우선

### 테마 동기화

```typescript
monaco.editor.defineTheme('nexus-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [...],
  colors: {
    'editor.background': '#0a0a0a',  // Tailwind v4 다크 테마와 매칭
    // ... 앱 CSS 변수에서 추출
  }
})
```

---

## 4. 안건 3: 다중 워크스페이스/세션

### 결정: 워크스페이스 분할 허용, 최대 2분할

### Activity Bar 워크스페이스 아이콘

```
Activity Bar (상단→하단):
[N]        ← Nexus 로고
────
[P●]       ← project-a (running, 파란 pulse)
 ³         ← 미확인 메시지 3건 배지
[N◉]       ← nexus-code (idle+세션, 초록 dot)
[A○]       ← api-server (비활성)
[+]        ← 워크스페이스 추가
────
[탐][에][설]
```

**상태 인디케이터:**

| 상태 | 시각 표현 | CSS 클래스 |
|------|----------|-----------|
| running | 파란 pulse dot | `bg-primary animate-pulse` |
| idle + 세션 있음 | 초록 정지 dot | `bg-success` |
| waiting_permission | 주황 dot | `bg-warning` |
| error | 빨간 dot | `bg-error` |
| 세션 없음 | dot 없음 | — |

**미확인 배지:**
- 비활성 워크스페이스에서 Claude 응답 완료 시 배지 카운트 증가
- 해당 워크스페이스로 전환하면 리셋
- 에러 시 배지 색상 빨강

### 워크스페이스 hover 플라이아웃

```
┌─────────────────────┐
│ nexus-code           │
│ ~/workspaces/nexus   │
│ ● Claude 작업 중     │
│ [세션: abc123]       │
│ ───────────────────  │
│ 최근 세션:           │
│  > 2h전 리팩토링     │
│  > 어제 버그 수정    │
└─────────────────────┘
```

### 패널 레이아웃 독립 보존

**각 워크스페이스는 자체 패널 레이아웃을 보존한다.**

```
워크스페이스 A: [Chat 45%] [Editor 55%]           ← 코드 작업 중
워크스페이스 B: [Chat 100%]                        ← 대화만 진행
워크스페이스 C: [Chat 35%] [Editor 35%] [Brw 30%] ← 풀스택 디버깅
```

**레이아웃 스토어 (신규):**

```typescript
// layout-store.ts (신규 생성)
const _layoutStores = new Map<string, WorkspaceLayout>()

// PanelLayoutNode — 패널 분할 트리 (재귀 구조)
interface PanelLayoutNode {
  panels: Array<{ id: string; type: PanelType; size: number }>
  orientation: 'horizontal' | 'vertical'
  children?: PanelLayoutNode[]
}

// WorkspaceLayout — 워크스페이스 레벨 상태 (트리와 분리)
interface WorkspaceLayout {
  root: PanelLayoutNode
  openFiles: string[]
  activeFile: string | null
  browserUrl: string | null
  chatScrollPosition: number
  bottomPanelVisible: boolean
  bottomPanelHeight: number  // 비율 (%)
}
```

**SessionStore와 분리하는 이유:** SessionStore는 세션 라이프사이클과 결합 (`reset()` 호출 시 레이아웃까지 날아가면 안 됨).

**전환 흐름:**
1. Activity Bar에서 워크스페이스 아이콘 클릭
2. 현재 워크스페이스의 레이아웃 상태 → `_layoutStores.set(currentPath, layout)`
3. 대상 워크스페이스의 레이아웃 → `_layoutStores.get(targetPath)` → 패널 그리드 교체
4. `setActiveStore(store)` 호출 (현재 코드에 이미 존재)
5. 전환 애니메이션: **없음** — 즉시 전환

**영속성:** 메모리에 유지. 앱 종료 시 `localStorage`에 persist → 재시작 시 복원.

### 워크스페이스 분할 뷰

**드래그 인터랙션:**

```
Step 1: Activity Bar에서 워크스페이스 아이콘을 Panel Grid로 드래그
Step 2: 드롭 존 표시 (가장자리 20% 영역, 반투명 primary 오버레이)
Step 3: 드롭 → 50:50 분할

┌──────┬─────────────┬─────────────┐
│ Act  │ WS-A        │ WS-B        │
│ Bar  │ [Chat]      │ [Chat]      │
│      │ Claude      │ Claude      │
│      │ 작업 중...  │ idle        │
└──────┴─────────────┴─────────────┘
```

**분할 규칙:**
- 최대 **2분할** (좌우 또는 상하)
- 드롭 후 50:50 비율, 이후 드래그로 조절
- 분할 해제: 아이콘을 Activity Bar로 다시 드래그, 또는 닫기 버튼
- 키보드: `Cmd+Shift+\` — 현재 워크스페이스 우측 분할 + 다음 워크스페이스 배치

**SessionStoreContext 격리:**

```tsx
// 분할 시 각 워크스페이스 영역을 별도 Provider로 감싸기
<PanelGroup direction="horizontal">
  <Panel>
    <SessionStoreContext.Provider value={storeA}>
      <WorkspacePanel />  {/* 워크스페이스 A */}
    </SessionStoreContext.Provider>
  </Panel>
  <PanelResizeHandle />
  <Panel>
    <SessionStoreContext.Provider value={storeB}>
      <WorkspacePanel />  {/* 워크스페이스 B */}
    </SessionStoreContext.Provider>
  </Panel>
</PanelGroup>
```

**주의:** 현재 `_activeStore` (전역 싱글턴, `session-store.ts:130`)에 의존하는 코드는 분할 뷰에서 깨짐. "어느 패널이 포커스인지"를 별도 추적하는 `focusedWorkspace` 상태가 필요.

### 동시 세션 제한

| 동시 세션 | 예상 메모리 (Electron ~300MB 포함) |
|-----------|----------------------------------|
| 1개 | ~500MB |
| 3개 | ~900MB |
| 5개 | ~1.3GB |
| 8개 | ~2GB |

- **권장 동시 활성: 5개** (8GB 머신 기준 안전)
- UI에서 soft limit 표시 (5개 초과 시 경고)

### 비활성 워크스페이스 프로세스 관리

- **자동 suspend 비권장** — 프로세스 kill 후 재시작 시 5-10초 콜드스타트
- 비활성 CLI 프로세스는 idle 상태로 유지 (CPU 0%, 메모리만 점유)
- **30분 idle 타이머** — 초과 시 프로세스 종료, resume 대기 상태로 전환
- 사용자 명시적 "세션 종료" 시 즉시 kill
- 재활성화 시 `--resume`으로 자동 재개
- 현재 `ACTIVITY_TIMEOUT_MS` (120초, `run-manager.ts:27`)와 별도의 장기 idle 타이머 추가

---

## 5. 안건 4: 에이전트 시각화

### 결정: Bottom Panel 탭 기본 + 인라인 카드 + Activity Bar 플라이아웃

에이전트 시각화는 **3곳**에 존재한다:

### (A) 채팅 내 인라인 에이전트 카드

**접힌 상태 (기본):**
```
┌─────────────────────────────────────────────┐
│ ▶ 에이전트 3명 작업 중   ████████░░ 70%     │
│   ● architect  ● engineer  ○ qa             │
└─────────────────────────────────────────────┘
```
- 한 줄 요약: 에이전트 수 + 진행률 바 + 이름 나열
- 각 이름 옆 상태 dot: `●` running, `◉` idle, `○` stopped
- 클릭 또는 `▶`로 펼치기

**펼친 상태:**
```
┌─────────────────────────────────────────────┐
│ ▼ 에이전트 3명 작업 중   ████████░░ 70%     │
│ ┌─ architect ● ──────────────────── 3.2s ─┐ │
│ │ Read  src/module.ts           0.8s  ✓   │ │
│ │ Read  src/types.ts            0.3s  ✓   │ │
│ │ Grep  "interface.*Props"      0.2s  ✓   │ │
│ └─────────────────────────────────────────┘ │
│   ┌─ engineer ● ─────────────────── ─── ─┐ │
│   │ Edit  src/module.ts          1.1s  ✓  │ │
│   │ Write src/module.test.ts     ───  ... │ │
│   └───────────────────────────────────────┘ │
│   ┌─ qa ○ ──────────────── 대기 중 ──────┐ │
│   │ (아직 시작되지 않음)                    │ │
│   └───────────────────────────────────────┘ │
│                                 [타임라인] ↗ │
└─────────────────────────────────────────────┘
```
- 현재 `AgentTimeline`의 `AgentCard` + `ToolRow` 구조 재사용
- 들여쓰기로 parent-child 관계 (`ml-4 border-l-2`)
- 도구 호출: 최근 3건, "더 보기"로 전체
- 우하단 [타임라인] 링크 → Bottom Panel 타임라인 패널 열기

**인라인 카드 삽입 위치:**
- Claude가 에이전트를 spawn하는 시점(SendMessage/Agent 도구 호출 직후)에 채팅 메시지 흐름에 삽입
- 에이전트 작업 진행 중에는 스트리밍 메시지 대신 카드가 표시됨
- 에이전트 작업 완료 후 카드 아래에 최종 응답이 이어짐
- 카드는 해당 메시지 컨텍스트에 고정 (스크롤해도 위치 유지)

### (B) 전용 간트 차트 타임라인 (Bottom Panel 탭)

```
┌─ Timeline Panel ────────────────────────────────────────┐
│  시간축    0s     5s     10s    15s    20s    25s       │
│  ─────────┼──────┼──────┼──────┼──────┼──────┼         │
│                                                         │
│  main     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓       │
│           │ SendMessage          │                      │
│           ▼                      ▼                      │
│  arch     ┃  ████████            ┃                      │
│           ┃  Read  Read  Grep    ┃                      │
│           ┃          │           ┃                      │
│           ┃          ▼           ┃                      │
│  eng      ┃     ░░░░░████████   ┃                      │
│           ┃     대기  Edit Write ┃                      │
│           ┃                │     ┃                      │
│           ┃                ▼     ┃                      │
│  qa       ┃           ░░░░░████ ┃                      │
│           ┃           대기  Bash ┃                      │
│                                                         │
│  ──── 도구 호출 로그 ───────────────────────────────     │
│  10:32:15  arch   Read   src/module.ts      0.8s  ✓    │
│  10:32:16  arch   Read   src/types.ts       0.3s  ✓    │
│  10:32:17  eng    Edit   src/module.ts      1.1s  ✓    │
└─────────────────────────────────────────────────────────┘
```

**간트 차트 설계:**
- 가로축: 시간 (세션 시작부터 상대 시간, 초 단위)
- 세로축: 에이전트별 행. `buildTree()` 순서, 들여쓰기로 depth
- 바 색상:
  - `████` 실행 중: primary 색상
  - `░░░░` 대기 중: muted 색상
  - 완료: primary/50 (반투명)
  - 에러: error 색상
- 화살표: `SendMessage` 도구 호출을 수직 화살표(┃ + ▼)로 표현
- 바 내부 텍스트: 도구 이름 축약 (공간 있으면 표시, 없으면 hover)
- running 상태: 바 길이가 실시간으로 성장 (1초 간격 갱신)
- 하단 로그: 도구 호출 테이블 (현재 `AgentTimeline`의 `ToolRow` 데이터)

**인터랙션:**
- 바 hover: 에이전트 도구 호출 상세 팝오버
- 바 클릭: 하단 로그를 해당 에이전트로 필터링
- 시간축 드래그: 좌우 스크롤
- 핀치/스크롤: 시간축 줌 인/아웃

**미팅 세션 표시:**
```
  main     ▓▓▓▓[MEET]▓▓▓▓▓▓▓▓
```
- 미팅 구간은 `[MEET]` 마커로 특별 표시
- 해당 구간의 에이전트들은 동시 활성 상태

### (C) Activity Bar 에이전트 플라이아웃

```
┌─────────────────────────┐
│ 에이전트 (3/5 활성)      │
│                          │
│ ● main           25.3s  │
│   ● architect      3.2s │
│   ● engineer       ───  │
│   ○ qa            대기   │
│   ○ reviewer      대기   │
│                          │
│ 도구 호출: 12건          │
│ 에러: 0건                │
│                          │
│ [타임라인 열기]          │
└─────────────────────────┘
```

- Activity Bar의 에이전트 아이콘 클릭 시 플라이아웃
- 트리 구조 들여쓰기 (`buildTree()` 활용)
- [타임라인 열기] → Bottom Panel 타임라인 패널 활성화

### 에이전트 상태 전환 애니메이션

| 전환 | 시각적 효과 |
|------|-----------|
| idle → running | dot: muted → primary + `animate-pulse`. 간트 바 성장 시작 |
| running → stopped | `animate-pulse` 정지 → dot `muted-foreground/40`. 바 끝 체크 아이콘 |
| running → error | `animate-pulse` 정지 → dot `bg-error`. 바 끝 빨강 경고 |
| 새 에이전트 spawn | 인라인 카드: 슬라이드 다운 200ms. 간트: 새 행 fade-in |

### 팀 미팅(meet) 시 메시지 흐름 표현

```
┌─ 인라인 Meet 카드 ──────────────────────────┐
│ ▼ 팀 미팅: "리팩토링 전략 논의"              │
│                                              │
│  ┌ architect ─────────────────────────────┐  │
│  │ 현재 모듈 구조를 분석한 결과, 3개 파일로 │  │
│  │ 분리하는 것을 제안합니다.                │  │
│  └────────────────────────────────────────┘  │
│  ┌ engineer ──────────────────────────────┐  │
│  │ 동의합니다. 다만 타입 파일은 별도로      │  │
│  │ 분리하는 게 좋겠습니다.                  │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  [d] 결정: 4파일 분리                        │
└──────────────────────────────────────────────┘
```

- 에이전트별 메시지 버블, 좌측에 에이전트 이름 + 역할 색상
- `[d]` 결정사항: primary 배경 강조
- 접힌 상태: "팀 미팅: 리팩토링 전략 논의 — 결정 1건"

---

## 6. 안건 5: 내장 브라우저

### 결정: webContentsView + 인라인 DevTools

### 브라우저 패널 구조

```
┌─ Browser Panel ──────────────────────────────┐
│ [◀] [▶] [⟳]  🔒 https://localhost:3000  [✕] │  ← React 렌더링 (36px)
├──────────────────────────────────────────────┤
│                                              │
│  [웹 콘텐츠 — webContentsView A]             │  ← main 프로세스 관리
│                                              │
│ ═══════════════ 드래그 리사이즈 ═════════════ │
│ [Elements] [Console] [Network] [Sources]     │
│                                              │  ← webContentsView B (DevTools)
│  DevTools 콘텐츠                              │
│                                              │
├──────────────────────────────────────────────┤
│ [📷 캡처 → Claude]  [DevTools ▾]    800×600  │  ← React 렌더링 (28px)
└──────────────────────────────────────────────┘
```

### 구현 방식: webContentsView 하이브리드

**왜 `<webview>` 태그가 아닌 `webContentsView`인가:**
- `<webview>`의 `openDevTools()`는 **항상 별도 창으로 열림** — Electron 제약
- 개발용 브라우저에서 DevTools가 분리되면 목적에 안 맞음 (사용자 피드백)
- `webContentsView`는 `setDevToolsWebContents()`로 인라인 DevTools 배치 가능

**구현 흐름:**

```
1. main 프로세스에서 webContentsView 2개 생성:
   - viewA: 웹 페이지
   - viewB: DevTools

2. viewA.webContents.setDevToolsWebContents(viewB.webContents)
   → DevTools 출력이 viewB로 전달

3. 두 뷰의 bounds를 BrowserWindow 내 패널 영역에 맞게 배치

4. renderer에서 패널 리사이즈 시 → IPC로 bounds 업데이트
   → requestAnimationFrame 디바운싱으로 부드럽게 처리
```

**URL 바/네비게이션:** renderer에서 React로 렌더링. URL 변경, 뒤로/앞으로 등은 IPC로 main에 전달.

### 브라우저 열림 규칙

| 트리거 | 동작 |
|--------|------|
| Claude 응답에 URL 텍스트 (`localhost:3000` 등) | **인라인 [브라우저에서 열기 ↗] 버튼** 표시. 클릭 시 열림 |
| `browser_navigate` 도구 직접 호출 (Playwright MCP 등) | **자동 열림** |
| `Cmd+Shift+B` | 브라우저 패널 토글 |

### 스크린샷 캡처 → Claude 전달

```
[📷 캡처] 클릭 (또는 Claude의 browser_take_screenshot 도구 호출)
  → webContentsView.webContents.capturePage()
  → NativeImage → nativeImage.toDataURL()
  → base64 → ImageAttachment { mediaType: 'image/png', data: base64 }
  → ChatInput에 이미지 첨부로 자동 삽입
  → 사용자가 메시지 추가 후 전송
```

- `capturePage()`는 visible 영역만 캡처 (첫 버전 충분)

### 보안

```html
webPreferences: {
  contextIsolation: true,    // 필수
  nodeIntegration: false,    // 필수
  sandbox: true              // 필수
}
partition: 'browser-panel'   // 앱 세션과 쿠키/스토리지 격리
```

- `will-navigate`, `new-window` 이벤트 가로채기
- 허용 목록: `localhost`, `127.0.0.1`
- 그 외 URL → `shell.openExternal()`로 시스템 기본 브라우저에 위임

### 제한

- 워크스페이스당 webview **최대 1개** (각각 별도 렌더러 프로세스, ~80-100MB)
- 여러 URL은 `src` 교체로 탭 전환
- 분할 뷰 시 2개 워크스페이스가 각각 브라우저를 열면 webview 2개까지 허용

### Chromium 호환성

- Electron 41 = **Chromium 136** 직접 번들링
- Chrome과 동일한 Blink(CSS)/V8(JS)/Skia(그래픽) 엔진
- OS 네이티브 웹뷰에 의존하지 않으므로 렌더링 차이 없음
- DevTools도 Chrome DevTools와 동일

---

## 7. 안건 6: 마크다운 렌더링

### 결정: 에디터 탭 내부 프리뷰, MarkdownViewer 폐기

### 채팅 내 인라인 렌더링 (변경 없음)

현재 `MarkdownRenderer.tsx` + `react-markdown` + `remarkGfm` + `CodeBlock.tsx` 조합 유지.

**추가 사항:**
- 코드블록에 [에디터] 버튼 추가 (안건 2에서 결정)
- 테이블 렌더링 스타일링 보완

### 에디터 탭 내부 마크다운 프리뷰

**.md 파일 열 때 자동으로 3모드 토글 활성화:**

```
┌─ Editor Panel ──────────────────────────────────────┐
│ [README.md ●]  [handler.ts]                         │
│ ════════════════════════════════════════════════════ │
│ ┌─ Monaco ────────────┬─ Preview ────────────────┐  │
│ │ # Title             │  Title                   │  │
│ │ ## Setup            │  ═════                   │  │
│ │ ```bash             │  Setup                   │  │
│ │ bun install         │  ┌────────────────────┐  │  │
│ │ ```                 │  │ bun install        │  │  │
│ │                     │  └────────────────────┘  │  │
│ └─────────────────────┴──────────────────────────┘  │
│ [편집만] [●분할] [프리뷰만]                 Markdown  │
└─────────────────────────────────────────────────────┘
```

**3가지 뷰 모드 (에디터 하단 토글 바):**
- **편집만**: Monaco만 표시
- **분할** (기본): 좌 Monaco + 우 MarkdownRenderer (50:50)
- **프리뷰만**: MarkdownRenderer만 표시 (읽기 전용)

**구현:**

```tsx
function EditorTab({ file }: { file: OpenFile }) {
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>(
    file.path.endsWith('.md') ? 'split' : 'edit'
  )
  const [previewContent, setPreviewContent] = useState(file.model.getValue())
  const isMarkdown = file.path.endsWith('.md')

  useEffect(() => {
    if (!isMarkdown) return
    const disposable = file.model.onDidChangeContent(() => {
      setPreviewContent(file.model.getValue())
    })
    return () => disposable.dispose()
  }, [file.model, isMarkdown])

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex">
        {(mode === 'edit' || mode === 'split') && (
          <MonacoEditor model={file.model} className="flex-1" />
        )}
        {(mode === 'preview' || mode === 'split') && isMarkdown && (
          <div className="flex-1 overflow-auto p-4">
            <MarkdownRenderer content={previewContent} />
          </div>
        )}
      </div>
      {isMarkdown && (
        <div className="h-7 flex items-center gap-2 px-2 border-t">
          <button onClick={() => setMode('edit')}>편집만</button>
          <button onClick={() => setMode('split')}>분할</button>
          <button onClick={() => setMode('preview')}>프리뷰만</button>
        </div>
      )}
    </div>
  )
}
```

- 비마크다운 파일(`.ts`, `.tsx` 등)에서는 토글 바 미표시
- 스크롤 동기화: Monaco 스크롤 시 프리뷰도 대응 위치로 동기 스크롤

### 컴포넌트 운명

| 컴포넌트 | 처리 |
|----------|------|
| `MarkdownRenderer.tsx` | **유지** — 채팅 + 에디터 프리뷰 양쪽에서 재사용 |
| `MarkdownViewer.tsx` | **폐기** — 에디터 프리뷰 모드가 대체 |
| `CodeBlock.tsx` | **유지 + 확장** — [에디터] 버튼 추가 |

---

## 8. 컴포넌트 마이그레이션 맵

### 삭제 대상

| 파일 | 이유 |
|------|------|
| `src/renderer/components/layout/MainPanel.tsx` | ChatPanel이 패널 그리드의 일반 패널로 승격 |
| `src/renderer/components/layout/RightPanel.tsx` | 해체 — 각 탭이 독립 패널 또는 다른 위치로 이동 |
| `src/renderer/components/plugins/MarkdownViewer.tsx` | 에디터 프리뷰 모드가 대체 |
| `src/renderer/components/plugins/ChangesPanel.tsx` | Monaco DiffEditor로 흡수 |
| `src/renderer/components/shared/DiffView.tsx` | Monaco DiffEditor로 대체 |

### 전면 재작성

| 파일 | 변경 내용 |
|------|----------|
| `src/renderer/components/layout/AppLayout.tsx` | 3패널 고정 → Activity Bar + 패널 그리드 + Bottom Panel + Status Bar |
| `src/renderer/components/layout/Sidebar.tsx` | → `ActivityBar.tsx` + `FlyoutPanel.tsx` 분리 |

### 유지 + 수정

| 파일 | 변경 내용 |
|------|----------|
| `src/renderer/components/chat/ChatPanel.tsx` | 패널 그리드의 일반 패널로 래핑. 내부 로직 변경 없음 |
| `src/renderer/components/chat/StatusBar.tsx` | **유지** — Chat 패널 내부 세션 상태 표시. 글로벌 Status Bar와 역할 분리 (상세 정보는 여기, 요약은 글로벌) |
| `src/renderer/components/chat/CodeBlock.tsx` | [에디터] 버튼 추가 |
| `src/renderer/components/chat/MarkdownRenderer.tsx` | 에디터 프리뷰에서도 import (변경 없음) |
| `src/renderer/components/plugins/NexusPanel.tsx` | Activity Bar 플라이아웃으로 이동 |
| `src/renderer/components/plugins/AgentTimeline.tsx` | (A) 인라인 카드 버전 + (B) 간트 차트 버전으로 분리 |

### 신규 생성

| 파일 | 역할 |
|------|------|
| `src/renderer/components/layout/ActivityBar.tsx` | 좌측 44px Activity Bar |
| `src/renderer/components/layout/FlyoutPanel.tsx` | Activity Bar 플라이아웃 오버레이 |
| `src/renderer/components/layout/PanelGrid.tsx` | 패널 그리드 시스템 (탭 바 + 동적 패널 렌더링) |
| `src/renderer/components/layout/BottomPanel.tsx` | 하단 패널 (Timeline/Terminal/Problems 탭) |
| `src/renderer/components/layout/GlobalStatusBar.tsx` | 최하단 글로벌 상태 바 (기존 chat/StatusBar.tsx와 이름 충돌 방지) |
| `src/renderer/components/editor/EditorPanel.tsx` | Monaco Editor 패널 (파일 탭 + 에디터 + .md 프리뷰) |
| `src/renderer/components/editor/EditorTabBar.tsx` | 에디터 파일 탭 바 |
| `src/renderer/components/browser/BrowserPanel.tsx` | 내장 브라우저 패널 (URL 바 + webContentsView 영역) |
| `src/renderer/components/agent/InlineAgentCard.tsx` | 채팅 내 인라인 에이전트 카드 |
| `src/renderer/components/agent/GanttTimeline.tsx` | 간트 차트 타임라인 (Bottom Panel용) |
| `src/renderer/stores/layout-store.ts` | 워크스페이스별 패널 레이아웃 상태 |

---

## 9. 신규 타입 정의

### PanelType 및 PanelConfig

```typescript
// src/shared/types.ts에 추가

type PanelType = 'chat' | 'editor' | 'browser' | 'markdown-preview' | 'timeline'

interface PanelConfig {
  id: string
  type: PanelType
  props: Record<string, unknown>
}

// 패널 분할 트리 (재귀 구조)
interface PanelLayoutNode {
  panels: Array<{ id: string; type: PanelType; size: number }>
  orientation: 'horizontal' | 'vertical'
  children?: PanelLayoutNode[]
}

// 워크스페이스 레벨 레이아웃 상태 (트리와 분리)
interface WorkspaceLayout {
  root: PanelLayoutNode
  openFiles: string[]
  activeFile: string | null
  browserUrl: string | null
  chatScrollPosition: number
  bottomPanelVisible: boolean
  bottomPanelHeight: number
}
```

### 브라우저 IPC 타입 (신규)

```typescript
// src/shared/types.ts에 추가 — webContentsView 통신용

interface BrowserNavigateRequest { url: string; panelId: string }
interface BrowserResizeRequest {
  panelId: string
  bounds: { x: number; y: number; width: number; height: number }
}
interface BrowserCaptureRequest { panelId: string }
interface BrowserCaptureResponse { ok: boolean; dataUrl?: string }
interface BrowserDevToolsToggleRequest { panelId: string; open: boolean }
```

### AgentNode 확장

```typescript
// src/shared/types.ts — 기존 AgentNode 확장

interface AgentNode {
  // 기존 필드
  agentId: string
  parentAgentId?: string
  agentType?: string
  events: AgentToolEvent[]
  lastSeen: number
  startedAt?: number
  stoppedAt?: number
  status?: 'idle' | 'running' | 'error' | 'stopped'

  // 신규 필드
  label?: string           // UI 표시명 ("엔지니어", "QA" 등)
  currentTask?: string     // "panel-permissions.tsx 수정 중"
  teamId?: string          // 팀 그룹핑 키 (meet 세션 ID 등)
  model?: string           // 사용 중인 모델 ("opus", "sonnet")
  tokenUsage?: { input: number; output: number }
}
```

### AgentMessage (신규)

```typescript
// src/shared/types.ts에 추가

interface AgentMessage {
  id: string
  fromAgentId: string
  toAgentId: string | '*'   // '*' = broadcast
  content: string
  timestamp: number
  type: 'discuss' | 'decide' | 'delegate' | 'report'
}
```

### AgentTimelineData 확장

```typescript
// src/shared/types.ts — 기존 확장

interface AgentTimelineData {
  agents: AgentNode[]
  messages: AgentMessage[]   // 신규 추가
}
```

**AgentMessage 수집 파이프라인 (main 프로세스):**
- Claude CLI의 `SendMessage` 도구 호출을 `tool_call` 이벤트에서 감지
- `input`에서 `to`, `message` 추출 → `AgentMessage` 객체로 변환
- agent tracker (현재 `AgentNode.events`를 수집하는 곳)에 `messages[]` 수집 로직 추가
- renderer로 기존 `agent_timeline_update` IPC 채널을 통해 전달
- **이 작업은 Phase 3 작업 목록에 포함되어야 함** (아래 Phase 3 참조)

### EditorFile 타입 (신규)

```typescript
// src/shared/types.ts에 추가 — 직렬화 가능한 타입 (IPC/localStorage용)

interface EditorFile {
  path: string
  content: string
  language: string       // Monaco 언어 ID ('typescript', 'markdown' 등)
  isDirty: boolean
  isTemporary: boolean   // 코드블록에서 열린 임시 파일
}
```

**런타임 모델 관리:** `EditorFile`은 직렬화 가능한 데이터 타입이다. Monaco의 `ITextModel` 인스턴스는 런타임에서만 존재하므로 별도 Map으로 관리한다:

```typescript
// EditorPanel 내부 또는 editor-store.ts
const modelMap = new Map<string, monaco.editor.ITextModel>()

// EditorFile.content로 초기 모델 생성
function getOrCreateModel(file: EditorFile): monaco.editor.ITextModel {
  const uri = monaco.Uri.file(file.path)
  let model = modelMap.get(file.path)
  if (!model) {
    model = monaco.editor.createModel(file.content, file.language, uri)
    modelMap.set(file.path, model)
  }
  return model
}
```

섹션 7의 `EditorTab` 코드에서 `file.model`은 이 `getOrCreateModel()`의 반환값을 의미한다. `EditorFile` 타입 자체에 `model` 필드는 없으며, 직렬화 계층(EditorFile)과 런타임 계층(ITextModel Map)이 분리된다.

---

## 10. 목업 데이터

### 에이전트 팀 목업

```typescript
const mockAgentTimeline: AgentTimelineData = {
  agents: [
    {
      agentId: 'main',
      agentType: 'orchestrator',
      label: '리드',
      teamId: 'meet-001',
      status: 'running',
      startedAt: Date.now() - 30000,
      lastSeen: Date.now(),
      currentTask: '안건 4 논의 중',
      events: [
        {
          toolUseId: 't1',
          toolName: 'nx_meet_start',
          input: { topic: '에이전트 시각화' },
          timestamp: Date.now() - 30000,
          durationMs: 200
        },
      ]
    },
    {
      agentId: 'agent-eng',
      parentAgentId: 'main',
      agentType: 'engineer',
      label: '엔지니어',
      teamId: 'meet-001',
      status: 'running',
      startedAt: Date.now() - 25000,
      lastSeen: Date.now(),
      currentTask: 'AgentTimeline.tsx 수정',
      events: [
        {
          toolUseId: 't2',
          toolName: 'Read',
          input: { file_path: 'src/renderer/components/plugins/AgentTimeline.tsx' },
          timestamp: Date.now() - 24000,
          durationMs: 50
        },
        {
          toolUseId: 't3',
          toolName: 'Edit',
          input: { file_path: 'src/renderer/components/plugins/AgentTimeline.tsx' },
          timestamp: Date.now() - 15000,
          durationMs: 120
        },
      ]
    },
    {
      agentId: 'agent-qa',
      parentAgentId: 'main',
      agentType: 'qa',
      label: 'QA',
      teamId: 'meet-001',
      status: 'idle',
      startedAt: Date.now() - 20000,
      lastSeen: Date.now() - 5000,
      events: [
        {
          toolUseId: 't4',
          toolName: 'Bash',
          input: { command: 'bun run typecheck' },
          timestamp: Date.now() - 18000,
          durationMs: 3000
        },
      ]
    },
    {
      agentId: 'agent-res',
      parentAgentId: 'main',
      agentType: 'researcher',
      label: '리서처',
      teamId: 'meet-001',
      status: 'stopped',
      startedAt: Date.now() - 28000,
      stoppedAt: Date.now() - 10000,
      lastSeen: Date.now() - 10000,
      events: [
        {
          toolUseId: 't5',
          toolName: 'WebSearch',
          input: { query: 'gantt chart react library' },
          timestamp: Date.now() - 27000,
          durationMs: 1500
        },
      ]
    },
  ],
  messages: [
    {
      id: 'm1',
      fromAgentId: 'main',
      toAgentId: '*',
      content: '에이전트 시각화 방식 논의 시작',
      timestamp: Date.now() - 29000,
      type: 'discuss'
    },
    {
      id: 'm2',
      fromAgentId: 'agent-res',
      toAgentId: 'main',
      content: 'react-gantt 라이브러리 3개 비교 완료',
      timestamp: Date.now() - 10000,
      type: 'report'
    },
    {
      id: 'm3',
      fromAgentId: 'main',
      toAgentId: 'agent-eng',
      content: 'AgentTimeline에 간트 차트 추가',
      timestamp: Date.now() - 9000,
      type: 'delegate'
    },
  ]
}
```

### 워크스페이스 목업

```typescript
const mockWorkspaces: WorkspaceEntry[] = [
  { path: '/Users/dev/nexus-code', name: 'nexus-code', sessionId: 'sess-abc' },
  { path: '/Users/dev/my-api', name: 'my-api', sessionId: 'sess-def' },
  { path: '/Users/dev/docs-site', name: 'docs-site' },  // 비활성
]
```

### 에디터 파일 목업

```typescript
const mockEditorFiles: EditorFile[] = [
  {
    path: 'src/renderer/components/layout/AppLayout.tsx',
    content: '// ... 파일 내용',
    language: 'typescript',
    isDirty: true,
    isTemporary: false
  },
  {
    path: 'README.md',
    content: '# Nexus Code\n\n...',
    language: 'markdown',
    isDirty: false,
    isTemporary: false
  },
  {
    path: 'snippet-1.ts',
    content: 'function example() { ... }',
    language: 'typescript',
    isDirty: false,
    isTemporary: true  // 코드블록에서 열림
  },
]
```

### 브라우저 목업

```typescript
const mockBrowserState = {
  url: 'http://localhost:3000',
  isLoading: false,
  canGoBack: true,
  canGoForward: false,
  devToolsOpen: true,
  viewportSize: { width: 800, height: 600 }
}
```

---

## 11. 구현 Phase 로드맵

### Phase 1: 레이아웃 기반 전환

**목표:** 현재 3패널 고정 → Activity Bar + 패널 그리드 구조 전환

**작업:**
1. `ActivityBar.tsx` 신규 생성 — 현재 `Sidebar.tsx` collapsed 상태 확장
2. `FlyoutPanel.tsx` 신규 생성 — 워크스페이스 목록, 세션 히스토리 오버레이
3. `PanelGrid.tsx` 신규 생성 — 패널 타입 레지스트리 + 동적 렌더링
4. `BottomPanel.tsx` 신규 생성 — Timeline 탭 (기존 AgentTimeline 이동)
5. `GlobalStatusBar.tsx` 신규 생성 — 워크스페이스 상태 요약 (기존 chat/StatusBar.tsx와 분리)
6. `AppLayout.tsx` 전면 재작성
7. `RightPanel.tsx` 삭제 — NexusPanel은 Activity Bar 플라이아웃으로
8. `MainPanel.tsx` 삭제 — ChatPanel이 PanelGrid의 패널로 직접 등록
9. `layout-store.ts` 신규 생성
10. **`_activeStore` 싱글턴 → `focusedWorkspace` + Context 기반 주입 전환** — Phase 4까지 미루면 Phase 1-3 동안 싱글턴 의존 코드를 작성하게 되므로 Phase 1에서 선행. `SessionStoreContext.Provider`를 패널 단위로 주입하는 구조로 변경.
11. 활성 패널 시각적 피드백 — 포커스된 패널의 탭 바에 2px primary 보더, 비활성 패널은 dimmed 처리

**결과:** Chat-only 레이아웃이지만, 패널 시스템의 기반이 갖춰짐. Chat을 분할하거나 다른 패널 타입을 추가할 수 있는 확장 가능한 구조. Context 기반 스토어 주입이 선행되어 이후 Phase에서 다중 패널/워크스페이스 추가 시 리팩토링 불필요.

### Phase 2: Monaco Editor 통합

**목표:** 코드 편집 + Chat/Editor 분할

**작업:**
1. `@monaco-editor/react` 패키지 추가
2. `EditorPanel.tsx` 신규 생성 — Monaco + 파일 탭 바
3. `EditorTabBar.tsx` 신규 생성
4. Monaco 테마 동기화 (`nexus-dark`)
5. Edit/Write 도구 호출 → 에디터 자동 열림 연동
6. `CodeBlock.tsx` — [에디터] 버튼 추가
7. `ChangesPanel.tsx` 삭제 → Monaco DiffEditor로 대체
8. `DiffView.tsx` 삭제 → Monaco DiffEditor로 대체
9. .md 파일 프리뷰 모드 (편집/분할/프리뷰 3모드)
10. `MarkdownViewer.tsx` 삭제
11. 포커스 관리 (Escape → Chat, 전역 단축키 우선)

**결과:** Chat + Editor 분할 작업 가능. Claude의 코드 변경을 에디터에서 실시간 확인.

### Phase 3: 브라우저 + Bottom Panel 고도화

**목표:** 내장 브라우저 + 에이전트 간트 차트

**작업:**
1. `BrowserPanel.tsx` 신규 생성 — URL 바 + webContentsView 영역
2. main 프로세스: webContentsView 생성 + DevTools 연동 IPC (`BrowserNavigateRequest`, `BrowserResizeRequest` 등)
3. **webContentsView bounds 초기 배치**: `ResizeObserver`로 브라우저 패널 컨테이너를 감시, 첫 크기 확정 시 main에 bounds 전달. 패널 `display:none → visible` 전환(탭 스위칭) 시에도 bounds 재계산 필요
4. 스크린샷 캡처 → ChatInput 첨부 연동
5. `InlineAgentCard.tsx` 신규 생성 — 채팅 내 인라인 카드
6. `GanttTimeline.tsx` 신규 생성 — Bottom Panel 간트 차트
7. AgentNode 타입 확장 (label, currentTask, teamId)
8. AgentMessage 타입 추가
9. **AgentMessage 수집 파이프라인**: main 프로세스의 agent tracker에서 `SendMessage` 도구 호출을 감지 → `AgentMessage` 변환 → renderer 전달. 기존 `agent_timeline_update` IPC 채널 확장
10. Meet 세션 메시지 흐름 표현

**결과:** Chat + Editor + Browser 3패널 풀스택 개발 환경. 에이전트 실행 상세 모니터링.

### Phase 4: 워크스페이스 분할 뷰

**목표:** 다중 워크스페이스 동시 작업

**작업:**
1. 워크스페이스 드래그 → 분할 뷰 인터랙션
2. 분할 영역 상단 워크스페이스 이름 바(24px) 추가
3. 미확인 배지 시스템
4. `waiting_permission` 시 주황 dot + 클릭 전환
5. 30분 idle 자동 정리 + resume 패턴
6. 동시 세션 soft limit UI (5개 경고)

> **참고:** `_activeStore` → `focusedWorkspace` 전환과 `SessionStoreContext.Provider` 패널 단위 격리는 Phase 1에서 선행 완료됨.

**결과:** Nexus Code의 핵심 차별점 완성 — 다중 워크스페이스 동시 작업 + 에이전트 시각화.

---

## 12. 기술적 제약 및 주의사항

### Hard Constraints

| 항목 | 제약 | 대응 |
|------|------|------|
| `BrowserView` | Electron 30+에서 deprecated (현재 Electron 41) | `webContentsView` 사용 |
| webview `openDevTools()` | 항상 별도 창으로 열림 | `webContentsView` + `setDevToolsWebContents()` |
| Monaco 다중 인스턴스 | 인스턴스당 30-50MB | 단일 인스턴스 + 모델 전환, 분할 시에만 2개 |
| CLI 프로세스 메모리 | 프로세스당 ~100-200MB | 동시 5개 권장, 30분 idle 자동 정리 |
| webview 메모리 | 인스턴스당 ~80-100MB | 워크스페이스당 최대 1개 |
| 멀티윈도우 | Zustand 스토어 IPC 브릿지 비용 큼 | 싱글윈도우 + 패널 분할 (독립 창은 향후 검토) |

### 성능 가이드라인

| 시나리오 | 예상 메모리 |
|----------|-----------|
| Chat only (1 워크스페이스) | ~500MB |
| Chat + Editor (1 워크스페이스) | ~550MB |
| Chat + Editor + Browser (1 워크스페이스) | ~650MB |
| 3 워크스페이스 동시 (Chat+Editor 각각) | ~1.1GB |
| 5 워크스페이스 동시 (혼합) | ~1.5GB |

### 현재 코드 참조 포인트

| 기능 | 현재 파일 | 라인 참고 |
|------|----------|----------|
| 워크스페이스별 독립 스토어 | `session-store.ts` | `_workspaceStores = new Map<>()` (L126) |
| 세션별 스토어 매핑 | `session-store.ts` | `_sessionStores` Map (L128) |
| 활성 스토어 싱글턴 | `session-store.ts` | `_activeStore` (L130) |
| CLI 프로세스 spawn | `run-manager.ts` | `RunManager` 클래스 |
| Activity timeout | `run-manager.ts` | `ACTIVITY_TIMEOUT_MS` (L27, 120초) |
| Collapsed 사이드바 아이콘 | `Sidebar.tsx` | `CollapsedWorkspaceButton` (L19-62) |
| 에이전트 트리 빌드 | `AgentTimeline.tsx` | `buildTree()` |
| 에이전트 노드 타입 | `types.ts` | `AgentNode` interface |
| 파일 변경 추적 | `ChangesPanel.tsx` | — |
| Diff 뷰 | `DiffView.tsx` | — |
| 마크다운 렌더링 | `MarkdownRenderer.tsx` | `react-markdown` + `remarkGfm` |
| 마크다운 뷰어 | `MarkdownViewer.tsx` | IPC 기반 파일 로딩 |
| 우측 패널 탭 | `RightPanel.tsx` | Nexus/Changes/Markdown/Timeline 탭 |
| 설정 모달 | `SettingsModal.tsx` | 6카테고리 |
| 커맨드 팔레트 | `CommandPalette.tsx` | `Cmd+K` |

---

> **이 문서는 2026-04-01 미팅(meet ID: 2)의 모든 결정사항을 담고 있습니다.**  
> **각 안건의 결정 근거, 구체적 구현 방향, 타입 정의, 목업 데이터, Phase 로드맵이 포함되어 있으므로,**  
> **이 문서만으로 구현을 진행할 수 있습니다.**

---

## 부록: 검토 반영 로그

아키텍트/디자이너 검토 후 반영된 수정사항 (2026-04-01):

| # | 출처 | 지적 내용 | 반영 |
|---|------|----------|------|
| 1 | 아키텍트 | PanelLayout 재귀 트리와 워크스페이스 상태 혼합 | `PanelLayoutNode` + `WorkspaceLayout`으로 분리 |
| 2 | 아키텍트 | `_activeStore` 마이그레이션을 Phase 1으로 선행 | Phase 1 작업 항목 10번에 추가, Phase 4에서 제거 |
| 3 | 아키텍트 | 브라우저 IPC 타입 정의 누락 | 섹션 9에 `BrowserNavigateRequest` 등 5개 타입 추가 |
| 4 | 아키텍트 | 기존 chat/StatusBar.tsx와 이름 충돌 | `GlobalStatusBar.tsx`로 명명, 기존 StatusBar 역할 명시 |
| 5 | 아키텍트 | Bottom Panel Terminal 탭 구현 범위 미정의 | Bash 도구 출력 읽기 전용 로그로 정의, 인터랙티브 터미널은 범위 밖 |
| 6 | 디자이너 | Workspace Tab Bar 조건부 표시가 합의와 불일치 | 제거. 분할 뷰 시 영역 상단에 워크스페이스 이름 바(24px)로 대체 |
| 7 | 디자이너 | Status Bar에 기존 chat/StatusBar와의 관계 불명확 | 역할 분리 명시 (글로벌=요약+전환, Chat내부=상세) |
| 8 | 디자이너 | 활성 패널 시각적 피드백 누락 | 포커스 패널 탭 바 2px primary 보더, 비활성 dimmed 추가 |
| 9 | 디자이너 | 에이전트 인라인 카드 삽입 위치 기준 누락 | 에이전트 spawn 시점에 삽입, 진행 중 카드 표시, 완료 후 최종 응답 이어짐 |
| 10 | 디자이너 | 브라우저 자동 열림 규칙 — Playwright MCP 자동 열림 동의 | 설계서 기존 내용 유지 (일치 확인) |
| 11 | 아키텍트 | AgentMessage 수집 파이프라인 누락 (main 프로세스 측) | 섹션 9에 수집 파이프라인 설명 추가, Phase 3 작업 9번에 추가 |
| 12 | 아키텍트 | EditorFile 타입에 model 참조 없음, 런타임 관리 불명확 | 직렬화(EditorFile) vs 런타임(ITextModel Map) 분리 명시, getOrCreateModel() 코드 추가 |
| 13 | 아키텍트 | webContentsView 초기 bounds 타이밍 + 탭 전환 edge case | Phase 3 작업 3번에 ResizeObserver + display:none→visible 재계산 명시 |
