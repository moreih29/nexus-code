# 레퍼런스 조사 종합

> 조사일: 2026-03-27
> 5개 기능 도메인의 UX 패턴 조사 결과 종합 및 Nexus Code 적용 방안

---

## 1. 조사 개요

### 배경

Nexus Code는 Claude Code CLI를 GUI로 래핑하는 Electron 데스크톱 앱이다. MVP 이후 설계 재조정을 위해 기능별 최적 레퍼런스의 UX 패턴을 조사했다 (D2 결정).

### 조사 범위

| 도메인 | 레퍼런스 | 깊이 | 패턴 수 | 문서 |
|--------|----------|------|---------|------|
| 대화 UX | ChatGPT Desktop, Claude.ai, Gemini | 깊음 | 7 | [conversation-ux.md](conversation-ux.md) |
| 도구 호출 시각화 | VS Code Copilot Chat, Zed, JetBrains | 깊음 | 7 | [tool-visualization.md](tool-visualization.md) |
| 터미널/Bash 출력 | Warp, iTerm2, Hyper, Alacritty | 보통 | 5 | [terminal-output.md](terminal-output.md) |
| 파일 편집 | Cursor, Windsurf, Copilot Edits | 보통 | 5 | [file-editing.md](file-editing.md) |
| 에이전트 오케스트레이션 | CrewAI, AutoGen, Magentic-UI, LangGraph, MetaGPT | 깊음 | 7 | [agent-orchestration.md](agent-orchestration.md) |

### 방법론

- **수집 관점 4개**: 인터랙션 모델, 정보 밀도/계층, 상태 표시, 레이아웃/공간 배분
- **분석 구조**: What (관찰) + Why (근거, 추론은 "추정" 표기) + Trade-off (장단점)
- **편향 방지**: 수집과 평가 분리, "채택하지 않을 이유" 필수 기술, 도메인 간 교차 비교
- **역할 분담**: researcher(수집) → architect(실현성 검토) → principal+postdoc(종합)

### 아키텍처 제약 (architect 식별)

종합 이전에 이해해야 할 3가지 근본 제약:

**1. stream-json stdin은 user message만 전송 가능**
- tool_result를 직접 주입할 수 없다. AskUserQuestion 응답은 다음 user prompt로 우회 전달해야 한다.

**2. tool_call 이벤트는 실행 후 도착**
- Edit/Write 실행 전 승인/거부는 HookServer manual 모드에서만 가능하다. auto 모드에서는 파일이 이미 수정된 후 알림이 온다.

**3. 에디터 없는 채팅 래퍼**
- Cursor/Zed 스타일의 인라인 편집, 에이전트 커서 추적, CRDT 실시간 편집은 근본적으로 불가능하다. diff 뷰와 파일 변경 요약으로 대체해야 한다.

---

## 2. 도메인 간 교차 패턴

5개 도메인을 관통하는 4개 공통 원리.

### 교차 패턴 1: Progressive Disclosure (점진적 공개)

**출현**: T1(정보 밀도 계층), T2(도구 카드 접힘, 터미널 출력 3단계), T3(블록 접기/펼치기), T4(diff 집계 뷰), T5(Level 0-3 정보 계층)

정보를 기본 요약 상태로 표시하고, 사용자 요청 시 단계적으로 상세 정보를 공개한다.

**공통 구조**:
- **Level 0**: 상태 인디케이터 (아이콘, 색상 도트)
- **Level 1**: 한 줄 요약 ("Used read_file - 3 results", "3/5단계 진행 중")
- **Level 2**: 핵심 내용 확장 (도구 입출력, diff 내용, 명령 출력)
- **Level 3**: 전체 디버그 정보 (LLM 호출 로그, 토큰 수, 비용)

**Nexus 적용 원칙**: 모든 정보 표시 컴포넌트(ToolCard, MessageBubble, AgentCard)에 일관된 접힘/펼침 계층을 적용한다. 기본은 Level 1, 클릭으로 Level 2, 별도 패널(RightPanel)에서 Level 3.

**하위 원칙 — 블록/카드 기반 정보 단위**: Progressive Disclosure를 실현하는 물리적 수단. 메시지 턴(T1), 도구 카드(T2), 명령 블록(T3)이 모두 "접힘/펼침이 가능한 원자 단위"라는 동일 패턴이다.

### 교차 패턴 2: 승인/제어권 스펙트럼

**출현**: T2(4단계 범위 승인, YOLO 모드), T4(YOLO~단계별 검토), T5(Action Guards 리스크 분류, Co-Planning, Co-Tasking)

"얼마나 자율적으로 에이전트에게 맡길 것인가"를 사용자가 상황에 따라 조절할 수 있는 연속적 스펙트럼.

```
완전 수동 ←――――――――――――――――→ 완전 자율
[매번 승인] [세션 허용] [패턴 허용] [항상 허용] [YOLO]
```

**리스크 기반 기본값**:
- 읽기 전용 도구 → 자동 허용 (현재 구현 완료)
- 쓰기/실행 도구 → 명시적 승인 (HookServer manual 모드)
- 비가역 행동 → 항상 명시적 승인 + 추론 경로 표시

**Nexus 적용 원칙**: PermissionHandler의 이분법(자동/수동)을 리스크 3단계(저/중/고)로 세분화하고, 승인 범위를 4단계(이번 한 번/세션/워크스페이스/영구)로 확장한다.

### 교차 패턴 3: 상태 기계 모델

**출현**: T1(idle→streaming→complete→error), T3(running→success→failure), T4(생성 중→검토 대기→수락/거부), T5(idle→running→paused→completed/error)

시스템의 모든 주요 엔티티를 명시적 상태 기계로 모델링하고, 상태 전이를 시각적으로 표시한다.

**공통 상태 집합**:
```
idle → running → [paused/waiting] → completed | error
```

**Nexus 적용 원칙**: 현재 `SessionStatus`(idle|running|waiting_permission|ended|error)를 에이전트 레벨(AgentNode.status)과 도구 레벨(ToolCard.resolveStatus)까지 일관되게 확장한다. 3개 레벨의 상태 기계가 계층적으로 연동되어야 한다.

### 교차 패턴 4: 사후 복구 vs 사전 승인

**출현**: T2(Zed Checkpoint vs VS Code 승인), T4(Keep/Undo vs Apply), T5(Co-Tasking Time Travel vs Action Guards)

파괴적 행동에 대한 안전망을 "실행 전 승인"과 "실행 후 복구" 중 어디에 중점을 둘 것인가의 설계 선택.

| | 사전 승인 | 사후 복구 |
|--|----------|----------|
| 마찰 | 높음 | 낮음 |
| 안전성 | 높음 | 보통 |
| 속도 | 느림 | 빠름 |
| 적합 상황 | 비가역, 고위험 | 가역, 탐색적 |
| 레퍼런스 | VS Code 승인, Cursor Apply | Zed Checkpoint, Cursor Undo |

**Nexus 적용 원칙**: 리스크 기반 하이브리드.
- 고위험(rm -rf, git push --force) → 사전 승인 필수
- 중위험(파일 편집, git commit) → 사전 승인 + 사후 복구 병행 (체크포인트)
- 저위험(파일 읽기, 검색) → 자동 실행

---

## 3. 패턴 분류 + 실현 가능성 통합 매트릭스

31개 패턴을 분류(핵심 채택 / 변형 적용 / 참고만)와 실현 가능성(높음/보통/낮음)으로 통합 평가한다.

### 분류 기준

- **핵심 채택**: Nexus Code에 직접 적용. 레퍼런스 패턴을 거의 그대로 구현
- **변형 적용**: 패턴의 원리를 차용하되 Nexus 아키텍처에 맞게 변형하여 구현
- **참고만**: 현재 아키텍처에서 불가하거나 ROI가 낮아 향후 참고용

### 대화 UX (T1)

| 패턴 | 분류 | 실현성 | 난이도 | 근거 |
|------|------|--------|--------|------|
| 스트리밍 출력 | 핵심 채택 | 높음 | Low | 이미 구현. 렌더링 최적화만 필요 |
| 턴 구분 | 핵심 채택 | 높음 | Low | 이미 구현. Claude.ai 스타일 전환 검토 |
| 요청 생명주기 상태 | 핵심 채택 | 높음 | Low | SessionStatus 타입 존재, UI 피드백 추가 |
| 입력 영역 구조 | 핵심 채택 | 높음 | Low | ChatInput 확장 (IME, 자동 높이, Stop) |
| 레이아웃 구조 | 핵심 채택 | 높음 | Low | 2-컬럼 구현 완료, 접힘/resize 추가 |
| 정보 밀도/코드 계층 | 핵심 채택 | 높음 | Low | 구문 강조, 복사 버튼, 메타데이터 추가 |
| 후속 액션 | 변형 적용 | 보통 | Med~High | Copy는 핵심 채택 수준(Low), Regenerate/Edit는 CLI 대화 분기 미지원으로 보류 |

### 도구 호출 시각화 (T2)

| 패턴 | 분류 | 실현성 | 난이도 | 근거 |
|------|------|--------|--------|------|
| 인라인 툴 카드 접힘 | 핵심 채택 | 높음 | Low | ToolCard에 전체 접힘 추가 |
| 계층적 승인 흐름 | 변형 적용 | 보통 | Med | PermissionHandler 캐시 + UI 확장 |
| 터미널 Progressive Disclosure | 핵심 채택 | 높음 | Low | CollapsibleResult 3단계 확장 |
| 상태 타임라인/디버그 뷰 | 핵심 채택 | 높음 | Low~Med | AgentTimeline 확장, Flow Chart는 Med |
| diff 뷰 + 파일 변경 요약 | 변형 적용 | 보통 | Med~High | PermissionCard diff + RightPanel 집계 |
| Zed 실시간 스트리밍 | 참고만 | 낮음 | Very High | 에디터 부재 근본 제약. 체크포인트만 Med |
| 중앙화 도구 관리 | 변형 적용 | 보통 | Med | settings.json 연동 + 관리 UI |

### 터미널/Bash 출력 (T3)

| 패턴 | 분류 | 실현성 | 난이도 | 근거 |
|------|------|--------|--------|------|
| 블록 기반 출력 | 핵심 채택 | 높음 | Low~Med | ToolCard 블록 강화, Sticky Header Med |
| AI 컨텍스트 통합 | 핵심 채택 | 높음 | Low | 앱 핵심 구조. 에러 분석 요청 버튼 추가 |
| 커맨드 팔레트 | 변형 적용 | 보통 | Med | 새 컴포넌트 + 커맨드 레지스트리 |
| 상태 표시 시스템 | 핵심 채택 | 높음 | Low | exit code, 경과 시간, 배경색 추가 |
| 편집기 스타일 입력 | 변형 적용 | 보통 | Low~High | 자동 높이 Low, 자동완성 Med, 구문강조 불필요 |

### 파일 편집 (T4)

| 패턴 | 분류 | 실현성 | 난이도 | 근거 |
|------|------|--------|--------|------|
| 인라인 편집 (Cmd+K) | 참고만 | 낮음 | Very High | 에디터 부재 근본 제약 |
| Chat Apply | 변형 적용 | 보통 | Med | HookServer manual + PermissionCard diff |
| Agent 멀티파일 편집 | 변형 적용 | 보통 | Med~High | 변경 집계 Med, Keep/Undo High |
| Tab 자동완성 | 참고만 | 낮음 | N/A | 에디터 범위 밖 |
| Diff 표시 방식 | 핵심 채택 | 높음 | Low~Med | EditRenderer 개선, unified diff |
| 상태 표시 | 핵심 채택 | 높음 | Low | PermissionCard 확장으로 자연 해결 |
| 레이아웃 | 변형 적용 | 보통 | Med | RightPanel Changes 탭 |

### 에이전트 오케스트레이션 (T5)

| 패턴 | 분류 | 실현성 | 난이도 | 근거 |
|------|------|--------|--------|------|
| 3-패널 캔버스 | 참고만 | 낮음 | N/A | 빌드 타임 도구, CLI 래퍼와 부적합 |
| Co-Planning | 변형 적용 | 보통 | Med | TodoWrite 파싱 + Plan 뷰, NexusPanel 연계 |
| Action Guards | 핵심 채택 | 높음 | Low~Med | 이미 구현. 리스크 세분화 추가 |
| 스트리밍 진행 상태 | 핵심 채택 | 높음 | Low~Med | AgentTracker Level 0-3 확장 |
| Co-Tasking | 변형 적용 | 보통 | Low~N/A | AskUserQuestion 응답 Low, Time Travel N/A |
| 역할 기반 시각화 | 핵심 채택 | 높음 | Low~Med | agentId→역할 라벨/색상, Replay Med |
| 상태 기계 표시 | 핵심 채택 | 높음 | Low | AgentNode status + 색상 도트 |

### 분류 집계

| 분류 | 개수 | 비율 |
|------|------|------|
| **핵심 채택** | 18 | 58% |
| **변형 적용** | 9 | 29% |
| **참고만** | 4 | 13% |

---

## 4. 채택하지 않을 이유

실현 가능성이 높고 적용 가치가 있어 보이는 패턴이라도, 채택하지 않아야 하는 합리적 이유가 존재한다.

### 4-1. 도구 카드 기본 접힘 (T2)

**채택하지 않을 이유**: Claude Code의 도구 호출은 범용 챗봇과 다르다. 개발자가 "지금 무엇을 하고 있는가"를 실시간으로 파악해야 하는 경우가 많다. 기본 접힘은 투명성을 낮추고, 에러 발견을 지연시킬 수 있다.

**반론**: 에러 발생 시 자동 펼침 + 실행 중 도구는 펼친 상태 유지로 완화 가능. 완료된 성공 도구만 접으면 된다.

### 4-2. 4단계 승인 범위 (T2)

**채택하지 않을 이유**: 복잡한 승인 모델은 인지 부하를 가한다. 결국 "항상 허용"을 선택하거나 무시하게 되어 보안 효과가 사라진다. 현재의 이분법(자동/수동)이 오히려 명확할 수 있다.

**반론**: 기본값을 "이번 한 번"으로 설정하고, 확장 범위는 드롭다운 뒤에 숨기면 단순성과 유연성을 모두 확보 가능.

### 4-3. 블록 기반 출력 구조 (T3)

**채택하지 않을 이유**: Claude Code는 하나의 턴에서 여러 도구를 호출하고 중간에 텍스트 설명이 들어간다. 이 비선형 구조에 블록 모델을 강제하면 정보 흐름이 인위적으로 끊길 수 있다.

**반론**: 블록 단위를 "명령"이 아닌 "도구 호출"로 재정의하면 Nexus 맥락에 적합. ToolCard가 이미 이 역할을 수행 중.

### 4-4. Co-Planning 필수화 (T5)

**채택하지 않을 이유**: 모든 작업에 계획 단계를 강제하면 단순 질문에도 불필요한 지연이 발생한다. CLI가 이미 plan mode를 제공하므로 이중 구현이 된다.

**반론**: 선택적 활성화(복잡한 작업에만)로 마찰 최소화. NexusPanel Tasks가 이미 계획의 일부를 수행.

### 4-5. 실시간 스트리밍 편집 (T2, T4)

**채택하지 않을 이유**: 에디터가 아닌 채팅 래퍼에서 Zed/Cursor 스타일 실시간 편집은 아키텍처 근본 전환이 필요하다(Very High). 채팅 래퍼의 강점(낮은 진입장벽, 단순한 인터랙션)을 잃을 수 있다.

**반론**: 체크포인트(git stash 기반)만 채택하면 에디터 없이도 사후 복구 안전망 확보 가능(Medium).

### 4-6. 3-패널 오케스트레이션 캔버스 (T5)

**채택하지 않을 이유**: 빌드 타임 도구이며 CLI 래퍼와 맞지 않는다. 에이전트 2-3개일 때 그래프보다 목록이 효율적이다.

**반론**: 에이전트 5개 이상의 복잡한 팀 구성에서는 시각화 가치 있음. 현재 우선순위는 낮다.

### 4-7. 역할 기반 구조화 통신 (T5)

**채택하지 않을 이유**: 구조화 프로토콜은 유연성을 제한한다. Nexus의 SendMessage(자유 텍스트)는 창의적 문제 해결에 유리하다. CLI가 내부 통신을 외부에 노출하지 않으므로 시각화 자체가 불가능하다.

**반론**: 역할 라벨과 색상 구분만으로 충분한 시각적 구분이 가능. 통신 프로토콜 강제 없이도 이점 확보.

---

## 5. 적용 우선순위

아키텍처 변경 없이 가장 높은 ROI를 제공하는 패턴을 우선순위별로 제안한다.

### Tier 1: 즉시 착수 (Low 난이도, 높은 체감 개선)

| 순위 | 패턴 | 도메인 | 근거 |
|------|------|--------|------|
| 1 | ToolCard 기본 접힘 | T2 | 대화 가독성 대폭 개선. 완료+성공 카드만 접기 |
| 2 | 요청 생명주기 UI 피드백 | T1 | 상태별 스피너, Stop 버튼, 에러 CTA. 모든 세션에서 체감 |
| 3 | AgentNode 상태 인디케이터 | T5 | 색상 도트로 에이전트 활동 즉시 파악 |
| 4 | 에러 블록 배경색 강조 | T3 | non-zero exit code 즉시 식별 |
| 5 | AskUserQuestion 인라인 버튼 | T5 | 옵션 클릭으로 응답 전송. sendPrompt() 연동 |
| 6 | 코드 블록 구문 강조 + 복사 | T1 | shiki/react-syntax-highlighter + 복사 버튼 |

### Tier 2: 단기 개선 (Medium 난이도, 핵심 UX 강화)

| 순위 | 패턴 | 도메인 | 근거 |
|------|------|--------|------|
| 7 | Edit/Write diff PermissionCard | T2/T4 | manual 모드에서 파일 변경 전 diff 검토 |
| 8 | RightPanel "Changes" 탭 | T4 | 턴 내 파일 변경 집계 뷰 |
| 9 | AgentTimeline 이벤트 필터/확장 | T2 | 유형 필터, 타임스탬프, LLM 로그 |
| 10 | 커맨드 팔레트 (CMD-K) | T3 | 새 세션, 설정, 히스토리 빠른 접근 |
| 11 | 승인 범위 확장 | T2/T5 | PermissionHandler 세션 캐시 + UI |
| 12 | 체크포인트 (git stash 기반) | T2/T4 | 세션 시작 시 스냅샷 + Restore 버튼 |

### Tier 3: 중기 확장 (Medium~High 난이도, 차별화)

| 순위 | 패턴 | 도메인 | 근거 |
|------|------|--------|------|
| 13 | Co-Planning 뷰 | T5 | TodoWrite → Plan 뷰 + NexusPanel 연계 |
| 14 | 멀티파일 Keep/Undo | T4 | 파일별 백업/복원 인프라 |
| 15 | Agent Flow Chart | T2 | reactflow로 도구 호출 시퀀스 시각화 |
| 16 | Replay 기능 | T5 | 세션 로그 기반 사후 재생 |

### 보류 (아키텍처 제약)

| 패턴 | 도메인 | 이유 |
|------|--------|------|
| 인라인 편집 (Cmd+K) | T4 | 에디터 부재 |
| Tab 자동완성 | T4 | 에디터 범위 밖 |
| Zed 실시간 편집 스트리밍 | T2 | CRDT + 에디터 코어 필요 |
| 3-패널 편집 캔버스 | T5 | 빌드 타임 도구, CLI 래퍼와 부적합 |

---

## 부록: 교차 패턴과 아키텍처 원칙 대응

| 교차 패턴 | 구현 기반 | 영향 받는 컴포넌트 |
|-----------|----------|-------------------|
| Progressive Disclosure | Level 0-3 계층 일관 적용 | ToolCard, MessageBubble, AgentCard, CollapsibleResult |
| 승인/제어권 스펙트럼 | PermissionHandler 리스크 3단계 + 범위 4단계 | PermissionHandler, PermissionCard, settings.json |
| 상태 기계 모델 | SessionStatus → AgentNode.status → ToolCard.status 계층 연동 | session-store, AgentTracker, ToolCard |
| 사후 복구 vs 사전 승인 | 리스크 기반 하이브리드 | HookServer, git stash 체크포인트, PermissionCard |

---

*작성: principal + postdoc | 실현성 검토: architect | 패턴 수집: researcher*
*조사일: 2026-03-27*
