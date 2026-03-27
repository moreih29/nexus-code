# 에이전트 오케스트레이션 UX 패턴 조사

> 조사 범위: CrewAI, AutoGen/Magentic-UI, LangGraph Studio, MetaGPT, ChatDev 및 범용 에이전트 UX 원칙
> 조사 일자: 2026-03-27
> 초점: "사용자에게 에이전트 상태를 어떻게 보여주는가"

---

## 패턴 1: 3-패널 오케스트레이션 캔버스

**대표 사례**: CrewAI Studio, AutoGen Studio

### What
좌(AI 사고/로그) + 중앙(캔버스/그래프) + 우(컴포넌트 팔레트) 구조.
중앙 캔버스에서 에이전트를 노드로, 메시지 흐름을 엣지로 표현.
드래그 앤 드롭으로 에이전트 배치 및 연결.

CrewAI Studio 예시:
- 좌: AI Thoughts (워크플로우 설계 중 실시간 추론 스트림)
- 중앙: Canvas (에이전트·태스크를 연결된 노드로 표시)
- 우: Resources (드래그 앤 드롭 컴포넌트)

### Why
에이전트 네트워크의 토폴로지를 공간적으로 파악할 수 있게 한다.
실행 전 구조를 이해 → 실행 중 각 노드의 상태 추적이 자연스럽게 연결된다.

### Trade-off
- (+) 복잡한 멀티에이전트 구조를 한눈에 파악 가능
- (+) 자연어 입력과 시각 편집이 같은 상태를 공유하여 상호 교환 가능
- (-) 화면 공간을 많이 요구 — 소형 데스크톱이나 단일 패널 UI에서 공간 부족
- (-) 에이전트 수가 10개 이상으로 늘면 그래프가 복잡해져 가독성 저하

---

## 패턴 2: Co-Planning — 실행 전 계획 협의

**대표 사례**: Magentic-UI (Microsoft Research), LangGraph Studio

### What
사용자가 작업을 입력하면, 에이전트가 즉시 실행하지 않고 먼저 단계별 계획을 생성한다.
사용자는 계획을 편집(추가/삭제/재정렬)한 후 최종 승인한다.
LangGraph Studio는 "debug mode"로 각 노드 실행 전 일시정지 → 검토 → 재개 사이클을 지원한다.

Magentic-UI 구체적 패턴:
1. 사용자 입력 → 계획 초안 생성
2. 계획 편집 인터페이스 (추가/삭제/재생성 버튼)
3. 승인 → 실행 시작
4. 완료 후 Plan Learning: 계획을 갤러리에 저장하여 재사용

### Why
비가역적 행동(결제, 데이터 삭제)이 포함된 워크플로우에서 사용자 신뢰를 확보한다.
에이전트가 "무엇을 왜 할 것인가"를 사전에 공유하면 실행 중 개입 빈도가 줄어든다.

### Trade-off
- (+) 사용자 통제감 극대화 — 실수 전 교정 가능
- (+) 장기 기억(Plan Gallery)으로 재사용 가능
- (-) 단순 태스크에서는 불필요한 마찰 — "그냥 실행해라"는 욕구와 충돌
- (-) 계획 생성 시간만큼 초기 응답 지연 발생

---

## 패턴 3: Action Guards — 비가역 행동 전 승인 요청

**대표 사례**: Magentic-UI, LangGraph interrupt(), StackAI

### What
에이전트가 비가역적이거나 고위험 행동(결제 확인, 탭 닫기, 파일 삭제 등)을 실행하기 전에 일시정지하고 사용자 승인을 요청한다.

승인 인터페이스 4요소:
1. **Interrupt** — 실행 직전 그래프/워크플로우 일시정지
2. **알림** — 승인자에게 "무엇을 하려 하는가" 명확히 표시
3. **검토 UI** — 제안된 행동과 에이전트의 추론 경로 표시
4. **Resume** — 승인/거부/수정 후 재개

리스크 수준 분류:
- 저위험 → 자동 허용
- 중위험 → 백그라운드 알림 + 사후 검토
- 고위험 → 명시적 승인 필수

### Why
자율 에이전트가 실수를 되돌릴 수 없는 상황을 방지한다.
"얼마나 자율적으로 맡길 것인가"를 사용자가 컨텍스트에 따라 조정할 수 있다.

### Trade-off
- (+) 사용자가 리스크 수준을 정책으로 설정 → 일관된 안전성
- (+) LangGraph처럼 체크포인트 저장 시 일시정지 기간이 분~일 단위여도 상태 유지
- (-) 승인 피로(approval fatigue): 너무 자주 물으면 "항상 허용"으로 무시됨
- (-) 비동기 승인 대기 중 전체 파이프라인이 블록됨

---

## 패턴 4: 실시간 스트리밍 + 진행 상태 계층

**대표 사례**: BlenderLM, LangGraph Studio, CrewAI 트레이싱

### What
에이전트 실행 중 상태를 여러 계층으로 동시에 노출한다.

**계층 구조 (정보 밀도 순)**:
```
Level 0 (최소): 에이전트 아이콘 + idle/running/error 인디케이터
Level 1 (요약): "문서 분석 중 (3/5단계)" — 단계명 + 진행률
Level 2 (상세): 현재 도구 호출, 입력/출력 요약
Level 3 (전체): 토큰 수, 소요 시간, 비용, LLM 호출 로그
```

BlenderLM 구현 예시:
- 구조화된 계획(Plan) + 현재 단계 + 전체 단계 수 + 누적 비용을 스트리밍

이벤트 기반 패턴:
- 도구에서 `ProgressData` 이벤트를 방출
- React에서 `onCustomEvent` 핸들러로 수신
- 각 이벤트는 고유 ID로 제자리 업데이트 (불필요한 리렌더링 최소화)

### Why
폴링이나 추측성 스피너 없이 실제 실행 상황을 정확히 반영한다.
사용자가 "지금 무슨 일이 일어나고 있는지" 이해하면 불안감이 줄고 취소/개입 타이밍을 잡을 수 있다.

### Trade-off
- (+) "아직 살아있나?" 불안 제거 — 실시간 피드백으로 신뢰 향상
- (+) 비용/토큰 정보는 사용자가 위임 범위를 조정하는 데 도움
- (-) Level 3 정보가 항상 노출되면 인지 부하 과다 — Progressive Disclosure 필요
- (-) 스트리밍 구현 복잡도 증가 (SSE, WebSocket 또는 이벤트 버스 필요)

---

## 패턴 5: Co-Tasking — 실행 중 제어권 공유

**대표 사례**: Magentic-UI, LangGraph Studio 상태 편집

### What
에이전트 실행 중에도 사용자가 언제든지 개입하여 제어권을 가져갈 수 있다.

세 가지 Co-Tasking 유형:
1. **사용자가 에이전트를 중단** — 방향 수정 후 재개
2. **에이전트가 사용자에게 질문** — 누락된 컨텍스트/결정 요청
3. **사용자가 에이전트 출력 검증** — 후속 질문 또는 수정 요청

Magentic-UI 브라우저 에이전트 구현:
- 에이전트가 실시간으로 특정 행동(버튼 클릭, 검색어 입력)을 표시
- 사용자가 직접 브라우저를 조작 후 에이전트에게 제어권 반환
- 5가지 해결 방식: 커뮤니케이션, 검증, 의사결정, 컨텍스트 제공, 에러 처리

LangGraph Studio "Time Travel":
- 임의 노드에서 상태 편집 후 재실행
- 이전 스냅샷으로 되돌리기 (체크포인트 기반)

### Why
자율 에이전트는 비결정적 — 실행 경로가 사전에 완전히 알려지지 않는다.
중간 개입 없이 끝까지 기다리면 전체 재시작이 필요하지만, 상태 편집으로 부분 수정이 가능하다.

### Trade-off
- (+) 에이전트의 실수를 중간에 교정 → 전체 재실행 비용 절감
- (+) 사용자가 "얼마나 맡길지"를 동적으로 조정 가능
- (-) "내가 끼어들면 에이전트가 혼란스럽지 않을까" 불확실성 — 명확한 재개 지점 표시 필요
- (-) 상태 편집 UI가 복잡 — 초보 사용자에게 진입 장벽

---

## 패턴 6: 역할 기반 멀티에이전트 시각화

**대표 사례**: MetaGPT, ChatDev, CrewAI Flows

### What
에이전트에게 조직의 역할(CEO, CTO, 개발자 등)을 부여하고 역할별로 구분된 출력을 생성한다.

MetaGPT 구현:
- 각 에이전트 역할마다 정해진 출력 스키마 (Architect → 시스템 인터페이스 + 시퀀스 다이어그램)
- 비정형 자연어 대신 구조화된 메시지 프로토콜로 에이전트 간 통신
- 글로벌 메시지 풀에 모든 에이전트 출력이 누적 → 타임라인 형태로 읽기 가능

ChatDev Visualizer (Flask 기반):
- **Log Viewer**: 실시간 에이전트 상호작용 검사
- **Replay Viewer**: 저장된 멀티에이전트 대화 로그 시각화 재생
- **ChatChain Viewer**: 태스크 조정 흐름 검사

ChatDev 2.0 시각적 캔버스:
- 각 에이전트 = 노드, 상호작용 = 엣지
- 컨텍스트 흐름 설정 및 드래그 앤 드롭 구성

### Why
역할이 있으면 "지금 누가 무엇을 하고 있는가"가 명확해진다.
Replay 기능은 디버깅과 학습 모두에 유용하다.

### Trade-off
- (+) 역할 라벨이 있으면 비전문가도 에이전트 책임 범위 이해 가능
- (+) Replay로 완료된 워크플로우 사후 분석 가능
- (-) 역할 모델이 실제 작업 구조와 맞지 않으면 오히려 혼란
- (-) 구조화된 통신 프로토콜은 유연성을 제한 — 창의적 에이전트 협업에 제약

---

## 패턴 7: 상태 기계 기반 에이전트 상태 표시

**대표 사례**: 범용 에이전트 UI 원칙 (bprigent.com, agentic-design.ai)

### What
에이전트 상태를 명확한 상태 기계로 모델링하고 사용자에게 시각적으로 노출한다.

**기본 상태 집합**:
```
idle → running → paused (waiting for human) → completed / error
```

**표시 방법**:
- 에이전트 아이콘의 색상 도트 (회색=idle, 파란=running, 주황=paused, 빨간=error)
- 진행 중인 미션 목록 — "역순 타임라인"이 최적 (최신이 상단)
- 중단된(waiting) 미션 섹션 분리 — 인간 응답 대기 중임을 명확히 표시

**신뢰도 표시**:
- 신호등 색상, 체크마크, 경고 아이콘으로 AI 확신도 표현
- "에이전트 알파가 데이터를 수집 중..." 형태의 활성 에이전트 식별 텍스트

**미션 상태 분류**:
- 성공적으로 완료된 미션 (학습 참고용)
- 현재 실행 중인 미션
- 인간 개입 대기 중인 미션 (가장 눈에 띄게 표시)

### Why
사용자가 앱에 접속했을 때 첫 번째 목표는 현재 상태 파악이다.
상태가 불명확하면 신뢰가 깨진다 — "에이전트가 작동 중인가, 죽었는가?"

### Trade-off
- (+) 에이전트 수가 많아도 상태 머신 모델은 스케일아웃 가능
- (+) 정책 기반 상태 전이로 예측 가능한 행동 보장
- (-) 실제 에이전트 상태는 더 복잡 (retry 중인지, 어떤 도구를 쓰는지) — 단순화 과정에서 정보 손실
- (-) idle과 "느리게 실행 중"의 시각적 구분이 어려움

---

## 종합 요약

| 패턴 | 주요 도구 | 인터랙션 포인트 | 정보 밀도 |
|------|----------|----------------|----------|
| 3-패널 캔버스 | CrewAI, AutoGen | 빌드 타임 | 중 (토폴로지) |
| Co-Planning | Magentic-UI, LangGraph | 실행 전 | 중 (계획 단계) |
| Action Guards | Magentic-UI, LangGraph | 실행 중 (비가역 시점) | 고 (행동 + 추론) |
| 스트리밍 진행 상태 | BlenderLM, CrewAI | 실행 중 (연속) | 가변 (Level 0-3) |
| Co-Tasking | Magentic-UI, LangGraph | 실행 중 (任意) | 고 (상태 편집) |
| 역할 기반 시각화 | MetaGPT, ChatDev | 실행 중 + 사후 | 중 (역할별 출력) |
| 상태 기계 표시 | 범용 원칙 | 상시 (대시보드) | 저-중 (상태 요약) |

### 공통 UX 원칙

1. **항상 제어 가능** — 사용자는 언제든지 일시정지/취소할 수 있어야 한다
2. **투명성과 출처** — 누가(어느 에이전트) 무엇을 왜 하는지 이해 가능해야 한다
3. **점진적 공개** — 기본은 요약, 필요시 드릴다운 (인지 부하 관리)
4. **비용 인식 위임** — 리스크 수준에 따라 자동 허용/승인 요청 분류
5. **상태 우선 표시** — 첫 화면에서 "지금 무슨 일이 일어나고 있는가" 즉시 파악 가능

---

*참고 출처*
- [CrewAI Studio 문서](https://docs.crewai.com/en/enterprise/features/crew-studio)
- [AutoGen Studio 발표 — Microsoft Research](https://www.microsoft.com/en-us/research/blog/introducing-autogen-studio-a-low-code-interface-for-building-multi-agent-workflows/)
- [Magentic-UI — Microsoft Research](https://www.microsoft.com/en-us/research/blog/magentic-ui-an-experimental-human-centered-web-agent/)
- [LangGraph Studio 블로그](https://blog.langchain.com/langgraph-studio-the-first-agent-ide/)
- [4 UX Design Principles for Multi-Agent AI — Victor Dibia](https://newsletter.victordibia.com/p/4-ux-design-principles-for-multi)
- [7 UX Patterns for Human Oversight — Benjamin Prigent](https://www.bprigent.com/article/7-ux-patterns-for-human-oversight-in-ambient-ai-agents)
- [Agentic Design Patterns — agentic-design.ai](https://agentic-design.ai/patterns/ui-ux-patterns)
- [Agentic UX & Multi-Agent Systems — ViitorCloud](https://viitorcloud.medium.com/agentic-ux-multi-agent-systems-designing-digital-experiences-people-actually-trust-9298be412365)
- [MetaGPT 논문](https://arxiv.org/html/2308.00352v6)
- [ChatDev GitHub](https://github.com/OpenBMB/ChatDev)

---

## 실현성 검토 (Architect)

> 현재 아키텍처: AgentTracker (HookServer pre-tool-use → agentId별 추적 → PLUGIN_DATA broadcast), AgentTimeline 컴포넌트 (RightPanel Timeline 탭), PluginHost file-watch

### 패턴 1: 3-패널 오케스트레이션 캔버스

- **실현 가능성**: 낮음
- **기술적 제약**: 드래그 앤 드롭 에이전트 배치, 노드-엣지 그래프 편집은 **빌드 타임** 도구. Nexus Code는 런타임 CLI 래퍼이므로 에이전트 토폴로지를 사용자가 편집하는 시나리오가 아님. Claude Code CLI가 내부적으로 에이전트를 spawn하며, 사용자가 구조를 제어하지 않음.
- **필요 사항**: 읽기 전용 그래프 시각화(현재 에이전트 관계 표시)는 가능하나, 편집 기능은 CLI 아키텍처와 맞지 않음. `reactflow` 라이브러리로 읽기 전용 토폴로지 뷰는 구현 가능.
- **구현 난이도**: 읽기 전용 그래프 Medium, 편집 가능 캔버스 N/A (아키텍처 부적합)

### 패턴 2: Co-Planning (실행 전 계획 협의)

- **실현 가능성**: 보통
- **기술적 제약**: Claude Code CLI에서 Plan Mode(`/plan` 또는 에이전트 자체 계획)는 텍스트 응답으로 전달됨. 현재 `StreamParser`가 텍스트를 파싱하나, "계획"과 "실행"을 구조적으로 구분하지 않음. CLI의 `TodoWrite`/`TaskCreate` 도구 호출로 계획이 구조화되어 도착하면 파싱 가능.
- **필요 사항**: (1) `TodoWrite` tool_call을 계획 데이터로 해석하여 별도 Plan 뷰에 표시. (2) 사용자 편집(항목 추가/삭제/재정렬) 후 결과를 다음 프롬프트로 전달. (3) NexusPanel의 Tasks 섹션이 이미 이 역할의 일부를 수행 중.
- **구현 난이도**: Medium

### 패턴 3: Action Guards (비가역 행동 전 승인)

- **실현 가능성**: 높음
- **기술적 제약**: 없음. **이미 핵심 아키텍처에 구현되어 있다.** HookServer manual 모드에서 모든 도구 호출을 가로채고, `PermissionHandler.isAutoApproved()`로 위험도 분류, 고위험은 PermissionCard로 사용자 승인 요청.
- **필요 사항**: (1) 위험도 분류 세분화 — 현재 읽기 전용 vs 나머지의 이분법. 중위험(git push 등)과 고위험(rm -rf 등) 분리. (2) 범위별 승인 (세션/영구) — 패턴 2(tool-visualization)의 계층적 승인과 동일 과제. (3) 승인 UI에 에이전트 추론 경로 표시 — `agentId` 정보는 이미 `PermissionRequestEvent`에 포함.
- **구현 난이도**: 세분화 Low, 범위별 승인 Medium

### 패턴 4: 실시간 스트리밍 + 진행 상태 계층

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `AgentTracker`가 Level 2(도구 호출 상세) 수준의 정보를 수집하여 `AgentTimeline`에 표시. Level 0(에이전트 상태 인디케이터)과 Level 1(단계 요약)은 추가 UI 작업.
- **필요 사항**: (1) Level 0 — 에이전트 아이콘 + running/idle 상태 배지를 `AgentCard` 헤더에 추가. (2) Level 1 — `TodoWrite`/`TaskUpdate` 이벤트에서 "3/5단계" 진행률 추출. (3) Level 3 — `TurnEndEvent.costUsd/durationMs`를 타임라인에 누적 표시. (4) Progressive Disclosure — Level 0을 기본, 클릭으로 Level 2까지 확장.
- **구현 난이도**: Low~Medium

### 패턴 5: Co-Tasking (실행 중 제어권 공유)

- **실현 가능성**: 보통
- **기술적 제약**: (1) **사용자가 에이전트를 중단** → `RunManager.cancel()` (SIGINT)이 이미 구현. (2) **에이전트가 사용자에게 질문** → `AskUserQuestion` 도구로 가능하나, 현재 `AskRenderer`는 읽기 전용. 사용자 응답을 CLI에 전달하려면 다음 user prompt로 보내야 함 (stream-json stdin 제약). (3) **상태 편집/Time Travel** → CLI가 체크포인트/상태 편집을 지원하지 않으므로 불가.
- **필요 사항**: (1) `AskRenderer`에 인라인 응답 버튼 추가 — 옵션 클릭 시 해당 텍스트를 `sendPrompt()`로 전송. (2) 중단 후 재개는 현재 `cancel()` + 새 프롬프트로 가능. (3) Time Travel은 CLI 제약으로 불가.
- **구현 난이도**: AskUserQuestion 응답 Low, Time Travel N/A (CLI 제약)

### 패턴 6: 역할 기반 멀티에이전트 시각화

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `AgentTracker`가 `agentId`별로 도구 호출을 그룹화. Claude Code CLI의 에이전트는 이름(architect, engineer 등)으로 식별되므로, `agentId`를 역할 라벨로 직접 사용 가능.
- **필요 사항**: (1) `AgentCard`에 역할별 아이콘/색상 매핑. (2) 에이전트 간 메시지 흐름 시각화 — 현재 도구 호출만 추적하므로 에이전트 간 통신은 표시 불가 (CLI가 내부 통신을 외부에 노출하지 않음). (3) Replay 기능 — `cli-raw-logger`가 세션 로그를 저장하므로 사후 재생은 로그 파싱으로 가능.
- **구현 난이도**: 역할 라벨/색상 Low, Replay Medium

### 패턴 7: 상태 기계 기반 에이전트 상태 표시

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `SessionStatus`가 `idle | running | waiting_permission | ended | error` 상태 기계를 정의. 에이전트 레벨 상태는 `AgentTracker`에서 `lastSeen` + pending 도구 여부로 유추 가능.
- **필요 사항**: (1) `AgentNode`에 `status: 'idle' | 'running' | 'waiting'` 필드 추가. (2) `AgentCard` 헤더에 색상 도트 인디케이터. (3) 대기 중(waiting) 에이전트 섹션 분리 표시.
- **구현 난이도**: Low
