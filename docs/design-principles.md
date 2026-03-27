# Nexus Code 설계 원칙

> M2 이후 모든 마일스톤에서 참조하는 UI/UX 설계 가이드
>
> 기반: `docs/research/reference-summary.md` 섹션 2 (교차 패턴 4개)
> 작성일: 2026-03-27

---

## 1. Progressive Disclosure (점진적 공개)

### 원칙

모든 정보 표시 컴포넌트는 4단계 계층으로 표현한다.

| 레벨 | 정보량 | 트리거 | 위치 |
|------|--------|--------|------|
| Level 0 | 상태 인디케이터 (아이콘, 색상 도트) | 항상 표시 | 인라인 |
| Level 1 | 한 줄 요약 | 기본값 | 인라인 |
| Level 2 | 핵심 내용 확장 (입출력, diff) | 클릭으로 전환 | 인라인 펼침 |
| Level 3 | 전체 디버그 정보 (LLM 로그, 토큰, 비용) | 별도 패널 진입 | RightPanel |

**기본 표시는 Level 1.** 완료+성공 카드는 Level 1로 접히고, 실행 중이거나 에러인 카드는 Level 2 유지.

### 컴포넌트별 적용

#### ToolCard (`src/renderer/components/chat/ToolRenderer.tsx`)

현재 `ToolCard` 컴포넌트는 헤더(도구명 + 상태)와 본문(입출력)을 항상 표시한다. 목표 계층:

- **Level 0**: 헤더의 상태 배지 — `running` (pulse), `done` (green), `error` (red)
- **Level 1**: 헤더 + 한 줄 요약만 ("Bash — git status", "Read — src/main.ts (50줄)")
- **Level 2**: 헤더 + 입력 파라미터 + `CollapsibleResult` (현재 구현 수준)
- **Level 3**: RightPanel에서 raw JSON 입출력, 타임스탬프, 소요 시간

전환 규칙:
- 카드 헤더 클릭 → Level 1 ↔ Level 2 토글
- `status === 'running'` → 강제 Level 2 (접힘 불가)
- `status === 'error'` → 강제 Level 2 (접힘 불가)
- `status === 'done'` → 기본 Level 1 (접힘 상태)

`CollapsibleResult`는 이미 Level 2 내 자체 접힘을 구현한다 (10줄 초과 시 "N more lines" 버튼). 이 동작은 유지한다.

#### MessageBubble (`src/renderer/components/chat/MessageBubble.tsx`)

현재 assistant 버블은 `content` + `toolCalls` 목록을 그대로 표시한다. 목표 계층:

- **Level 0**: 역할 아이콘 (user = 우측 파란 말풍선, assistant = 좌측 회색 말풍선)
- **Level 1**: 메시지 본문 텍스트 (`MarkdownRenderer` 출력)
- **Level 2**: 메타데이터 — 타임스탬프, 턴 비용(`TurnEndEvent.costUsd`), 소요 시간
- **Level 3**: RightPanel에서 raw 메시지 JSON

Level 2 메타데이터는 메시지 호버 시 표시한다 (`opacity-0 group-hover:opacity-100`).

#### AgentCard (`src/renderer/components/plugins/AgentTimeline.tsx`)

현재 `AgentCard` 컴포넌트는 `agentId` + 이벤트 목록을 항상 펼쳐 표시한다. M2b에서 구현 예정인 에이전트 상태(status) 필드가 추가되면 아래 계층을 적용한다:

- **Level 0**: 헤더의 상태 도트 (색상 코드는 섹션 3 참조)
- **Level 1**: `agentId` + 상태 텍스트 + 총 호출 수 ("engineer — running, 5 calls")
- **Level 2**: 현재 실행 중인 `ToolRow` 목록 (완료된 도구는 접힘)
- **Level 3**: 전체 이벤트 타임라인 + 타임스탬프 + 소요 시간

### 구현 가이드

**애니메이션**: 펼침/접힘은 `max-height` transition 또는 Radix UI `Collapsible` 사용. `duration-150 ease-out`.

**접힘 상태 유지**: 사용자가 명시적으로 펼친 카드는 `sessionStorage`에 `toolUseId` 기준으로 기억. 새 세션 시작 시 초기화.

**에러 자동 펼침**: `resolveStatus(tc) === 'error'`이면 초기 렌더 시 Level 2로 강제 전환.

---

## 2. 승인/제어권 스펙트럼

### 원칙

"에이전트에게 얼마나 자율적으로 맡길 것인가"를 사용자가 상황에 따라 조절할 수 있는 연속 스펙트럼이다.

```
완전 수동 ←──────────────────────────────────→ 완전 자율
[이번 한 번] [세션 허용] [워크스페이스] [영구 허용] [YOLO]
```

현재 구현(`StartRequest.permissionMode`)은 `auto`/`manual` 이분법이다. M2b에서 리스크 3단계 × 범위 4단계로 확장한다.

**리스크 3단계**:

| 리스크 | 정의 | 기본 동작 |
|--------|------|-----------|
| 저위험 | 읽기 전용, 가역적 | 자동 실행 |
| 중위험 | 파일 쓰기, 실행 가능 명령 | 사전 승인 요청 |
| 고위험 | 비가역적, 시스템 영향 | 항상 명시적 승인 + 추론 경로 표시 |

**범위 4단계**:

| 범위 | 적용 기간 | 저장 위치 |
|------|-----------|-----------|
| 이번 한 번 | 현재 요청만 | 메모리 |
| 세션 | 현재 세션 종료까지 | `permission-store` 캐시 |
| 워크스페이스 | 해당 워크스페이스 전체 | `project settings.json` |
| 영구 | 모든 세션 | `global settings.json` |

### 컴포넌트별 적용

#### PermissionCard (`src/renderer/components/permission/PermissionCard.tsx`)

현재 `Allow` / `Deny` 2버튼 구조에서 리스크 레벨 표시 + 범위 선택으로 확장한다.

**리스크 레벨 표시** (헤더 영역):
- 저위험: 파란 도트 (`bg-blue-400`) + "자동 실행 중" 텍스트 — PermissionCard 미표시 (자동 처리)
- 중위험: 노란 도트 (`bg-yellow-400`) + "확인 필요" — 현재 `bg-yellow-400` 구현 유지
- 고위험: 빨간 도트 (`bg-red-500`) + "주의: 비가역적 작업" — `border-red-700/50 bg-red-950/40`

**범위 선택 드롭다운** (Action 영역):
- Allow 버튼 좌측에 드롭다운 → 이번 한 번 / 세션 / 워크스페이스 / 영구
- 기본값: "이번 한 번"
- 고위험 도구는 "영구" 선택 불가 (disabled)

**추론 경로 표시** (고위험 전용):
- `permission.input` 파라미터 아래에 "이 작업이 필요한 이유" 텍스트 블록 추가
- M2b에서 PermissionRequestEvent에 `reasoning?: string` 필드 추가 예정

#### 도구별 기본 리스크 분류

| 도구 | 리스크 | 근거 |
|------|--------|------|
| Read, Glob, Grep | 저위험 | 읽기 전용, 파일시스템 변경 없음 |
| Write, Edit, MultiEdit | 중위험 | 파일 내용 변경, git으로 복구 가능 |
| Bash (일반 명령) | 중위험 | 실행 가능하나 대부분 가역적 |
| Bash (`rm`, `rmdir`) | 고위험 | 파일 삭제, 복구 불가 |
| Bash (`git push --force`, `git reset --hard`) | 고위험 | 원격 히스토리 또는 로컬 변경 파괴 |
| Agent | 중위험 | 서브에이전트 생성, 세션 리소스 소비 |

### 구현 가이드

**기본값 전략**: 기본 범위는 항상 "이번 한 번". 사용자가 범위를 변경해야 더 넓은 허용이 된다. "YOLO 모드"(skipDangerousModePermissionPrompt)는 설정 화면에서만 활성화 가능.

**설정 저장**: 워크스페이스/영구 범위 허용은 `ClaudeSettings.permissions.allow` 배열에 도구명을 추가하는 방식으로 구현. `src/shared/types.ts`의 `ClaudeSettings` 인터페이스 활용.

---

## 3. 상태 기계 모델

### 원칙

시스템의 모든 주요 엔티티를 명시적 상태 기계로 모델링하고, 상태 전이를 시각적으로 표시한다. 3개 레벨이 계층적으로 연동된다.

```
Session
  └─ Agent (M2b 구현 예정)
       └─ Tool (ToolCallRecord)
```

상위 상태가 하위를 제약한다. 예: Session이 `ended`이면 하위 Tool은 모두 완료 처리.

### 상태 정의

#### Session 상태 (`src/shared/types.ts: SessionStatus`)

현재 구현 완료.

```
idle → running → waiting_permission → running → ended | error
              ↘                                        ↗
               error
```

| 상태 | 색상 | 표시 | 비고 |
|------|------|------|------|
| `idle` | 회색 | "준비됨" | 세션 없음 또는 종료 후 |
| `running` | 파란 pulse | "실행 중…" 스피너 | 스트리밍 수신 중 |
| `waiting_permission` | 노란 pulse | "승인 대기 중" | PermissionCard 표시 중 |
| `ended` | 회색 | "완료" | 정상 종료 |
| `error` | 빨간 | "오류 발생" | 에러 CTA 표시 |

#### Agent 상태 (`AgentNode` — M2b에서 구현 예정)

현재 `src/shared/types.ts`의 `AgentNode`는 `status` 필드가 없다. M2b에서 추가:

```
idle → running → paused → completed | error
```

| 상태 | 색상 도트 | 비고 |
|------|-----------|------|
| `idle` | `bg-gray-500` | 초기 상태 |
| `running` | `bg-blue-400 animate-pulse` | 현재 `AgentTimeline.tsx`의 `isRunning` 조건 |
| `paused` | `bg-yellow-400` | 승인 대기 또는 AskUserQuestion 대기 |
| `completed` | `bg-green-500` | 현재 `bg-green-500` |
| `error` | `bg-red-400` | 현재 `bg-red-400` |

#### Tool 상태 (`ToolCallRecord` — `src/renderer/components/chat/ToolRenderer.tsx`)

현재 `resolveStatus()` 함수로 파생 계산. 타입은 `Status = 'running' | 'done' | 'error'`.

```
pending → running → done | error
```

`pending` 상태는 현재 미구현 (M2a에서 ToolCallEvent 수신 즉시 `running`으로 처리).

### 컴포넌트별 상태 색상 코드

일관성을 위해 전체 컴포넌트에서 동일한 색상 시스템을 사용한다.

| 상태 | Tailwind 클래스 | 사용처 |
|------|----------------|--------|
| running/활성 | `text-blue-400`, `bg-blue-400 animate-pulse` | ToolCard 상태 배지, AgentCard 도트 |
| done/완료 | `text-green-400`, `bg-green-500` | ToolCard, AgentCard |
| error/오류 | `text-red-400`, `bg-red-400` | ToolCard, AgentCard |
| waiting/대기 | `text-yellow-400`, `bg-yellow-400` | Session 대기, PermissionCard 헤더 |
| idle/준비 | `text-gray-500`, `bg-gray-500` | 비활성 상태 |

현재 `AgentTimeline.tsx`의 `ToolRow`는 이미 이 패턴을 따른다 (21-26번째 줄). 신규 컴포넌트도 동일 클래스를 사용한다.

### 계층 간 연동 규칙

1. **Session `waiting_permission` → Agent `paused`**: PermissionRequestEvent를 발생시킨 agentId의 에이전트를 `paused`로 전환
2. **Session `error` → 모든 Agent `error`**: 세션 오류 시 하위 에이전트 상태 일괄 갱신
3. **Session `ended` → 실행 중 Agent `completed`**: SessionEndEvent 수신 시 `running` 상태 에이전트 완료 처리
4. **Agent 전체 `completed` → Session `ended` 표시**: 모든 에이전트가 완료되면 Session 상태 배지 업데이트

---

## 4. 사전 승인 / 사후 복구 하이브리드

### 원칙

파괴적 행동에 대한 안전망을 리스크에 따라 "사전 승인"과 "사후 복구"로 분기한다.

| 전략 | 마찰 | 속도 | 적합 상황 |
|------|------|------|-----------|
| 사전 승인 | 높음 | 느림 | 비가역, 고위험 |
| 사후 복구 | 낮음 | 빠름 | 가역, 탐색적 |
| 하이브리드 | 중간 | 중간 | 중위험 (Nexus 기본) |

### 리스크별 분기

#### 저위험: 자동 실행

Read, Glob, Grep — PermissionCard 미표시. `auto` 모드에서 승인 이벤트 자체가 발생하지 않는다. 사후 복구 불필요 (파일시스템 변경 없음).

#### 중위험: 사전 승인 + 체크포인트

Edit, Write, Bash (일반), Agent — HookServer `manual` 모드에서 PermissionCard 표시. 승인 후 실행. 세션 시작 시 git 기반 체크포인트를 생성하여 사후 복구 가능.

**체크포인트 동작** (M2b에서 구현 예정):
- 세션 시작 시 `git stash` 또는 `git commit --amend` 기반 스냅샷
- RightPanel 또는 PermissionCard에 "복원" 버튼 표시
- 복원은 스냅샷 시점 파일 상태로 되돌림

#### 고위험: 항상 승인 + 추론 경로

`rm`, `rmdir`, `git push --force`, `git reset --hard` — 범위 선택에서 "영구" 비활성화. 항상 이번 한 번 승인. PermissionCard에 추론 경로(why this action is needed)를 필수 표시.

### 컴포넌트별 적용

#### PermissionCard 리스크별 UI 차등

```
저위험: 표시 없음 (자동 처리)
중위험: 노란 테두리 [현재 구현] + "Allow(이번 한 번)" 드롭다운
고위험: 빨간 테두리 + 추론 경로 블록 + "Allow(이번 한 번)"만 허용
```

현재 `PermissionCard`의 노란 스타일 (`border-yellow-700/50 bg-yellow-950/40`)은 중위험의 기본 스타일로 그대로 사용한다.

고위험 추가 스타일: `border-red-700/50 bg-red-950/40`. 헤더의 `bg-yellow-400` 도트를 `bg-red-500`으로 교체.

#### 체크포인트 UI (M2b 구현 예정)

- **생성**: 세션 시작 시 자동. UI 알림은 표시하지 않음 (백그라운드 동작).
- **복원**: 세션 종료 후 또는 오류 발생 시 ChatInput 위에 "이전 상태로 복원" 배너 표시.
- **위치**: RightPanel "Changes" 탭 또는 세션 헤더 영역 (레이아웃 확정 전 보류).

---

## 부록: shadcn/ui 컴포넌트 매핑

M2a에서 shadcn/ui로 전환 시 참조. 현재 커스텀 구현과 shadcn 대응 컴포넌트.

| 현재 커스텀 | 위치 | shadcn 대응 | 전환 우선순위 |
|------------|------|-------------|--------------|
| `ToolCard` 접힘/펼침 | `ToolRenderer.tsx` | `Collapsible` | High |
| `CollapsibleResult` "N more lines" | `ToolRenderer.tsx` | `Collapsible` | High |
| `PermissionCard` 범위 드롭다운 (M2b) | `PermissionCard.tsx` | `Select` | Medium |
| `AgentCard` 헤더 접힘 (M2b) | `AgentTimeline.tsx` | `Collapsible` | Medium |
| 설정 화면 토글 | (미구현) | `Switch` | Low |
| 승인 범위 탭 (M2b) | `PermissionCard.tsx` | `Tabs` | Low |
| 커맨드 팔레트 (M2b) | (미구현) | `Command` | Medium |
| 코드 블록 | `MarkdownRenderer.tsx` | 외부 라이브러리 유지 추천 | — |

**전환 원칙**: 동일 동작을 shadcn이 제공하면 커스텀 구현을 제거한다. 단, Tailwind 다크 테마 (`bg-gray-800`, `text-gray-200` 계열)와 충돌하지 않도록 shadcn 컴포넌트의 CSS 변수를 프로젝트 테마에 맞게 재정의한다.

---

*작성: engineer | 기반 조사: reference-summary.md (principal + postdoc)*
*작성일: 2026-03-27*
