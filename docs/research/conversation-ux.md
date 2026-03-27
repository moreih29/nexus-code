# 대화 UX 레퍼런스 조사

ChatGPT Desktop, Claude Code Desktop 등 주요 AI 대화 앱의 UX 패턴 분석.

---

## 1. 스트리밍 출력 표시 (Streaming Output Display)

**What**: AI 응답이 토큰 단위로 실시간 렌더링되는 패턴. 커서 또는 깜빡이는 블록으로 생성 중임을 시각화.

**Why**: 응답 지연 시간이 긴 LLM 특성상 사용자가 "처리 중인지 멈춘 건지" 구분하기 어렵다. 스트리밍은 응답의 첫 토큰부터 즉시 보여줌으로써 체감 지연을 줄이고, 방향이 잘못됐을 때 조기에 중단(Stop)할 수 있게 한다.

**Trade-off**:
- 장점: 체감 지연 대폭 감소, 사용자가 응답 방향을 조기 판단 가능
- 단점: 마크다운 렌더링 중 레이아웃 점프 발생 (텍스트가 헤더/코드블록으로 변환될 때 높이 변동), 스크롤 위치 고정 로직 필요
- ChatGPT는 스트리밍 중에도 입력 수정이 가능해 mid-stream 재지시 지원; Claude는 현재 미지원

---

## 2. 메시지 턴 구분 (Turn Separation & Visual Hierarchy)

**What**: 사용자 메시지와 AI 응답을 시각적으로 명확히 구분하는 레이아웃 패턴. 일반적으로 우측 정렬(사용자) vs 좌측 정렬(AI), 아바타/아이콘, 배경색 차이 조합.

**Why**: 멀티턴 대화가 길어질수록 "내가 한 말"과 "AI가 한 말"이 섞이기 쉽다. 시각적 비대칭(asymmetry)은 인지 부하 없이 발화자를 즉시 구분하게 한다.

**Trade-off**:
- 좌우 분리(ChatGPT 스타일): 직관적이나 긴 메시지에서 우측 말풍선이 좁아지는 문제
- 아바타 + 좌측 정렬(Claude.ai 스타일): 넓은 텍스트 영역 확보, 긴 코드/텍스트에 유리
- 배경색 구분(이전 ChatGPT 스타일): 모바일에서 명확하나 다크모드에서 대비 설계 복잡도 증가

---

## 3. 요청 생명주기 상태 표시 (Request Lifecycle States)

**What**: 대화 요청의 전체 생명주기를 시각화하는 패턴. 상태: `idle → validating → sending → streaming → complete → (interrupted | failed)`

**Why**: 사용자가 현재 시스템이 어떤 상태인지 모르면 중복 클릭, 불필요한 재시도, 혼란이 발생한다. "내가 전송한 게 처리 중인가?"를 명확히 알려야 한다.

**Trade-off**:
- ChatGPT: 스트리밍 중 Stop 버튼 + 인풋 shimmer로 상태 표시; 에러 시 "Regenerate" CTA 즉시 제공
- Claude.ai: 로딩 스피너(퍼플 아이콘) + 점 애니메이션 타이핑 인디케이터
- 과도한 상태 애니메이션은 오히려 불안감 유발; 최소한의 시각 피드백으로 충분
- 에러 상태에서 입력한 프롬프트를 보존하고 재시도 옵션(retry, shorten, switch model)을 함께 제공하는 것이 중요

---

## 4. 입력 영역 구조 (Input Area Composition)

**What**: 프롬프트 입력 textarea + 전송 버튼 + 부가 컨트롤(파일 첨부, 도구 선택, 모드 전환)로 구성된 하단 고정 영역.

**Why**: 대화의 진입점이자 가장 빈번하게 접근하는 UI. 키보드 단축키, 자동 높이 조절, 빠른 액세스 컨트롤이 생산성을 결정한다.

**구체적 패턴**:
- **Enter 전송 / Shift+Enter 줄바꿈**: 채팅 앱 표준. IME(한국어/일본어/중국어) 사용자는 Enter 키가 후보 확정에도 쓰이므로 Ctrl+Enter 옵션 필요
- **자동 높이 조절**: 내용이 늘어날수록 textarea 높이 확장, 최대 높이 도달 시 내부 스크롤로 전환
- **프롬프트 컨트롤(NN/g 분류)**: 디스커버리(기능 힌트), 교육(예시 프롬프트), 범위 제한(Focus/모드), 후속 액션(수정, 재생성, 어조 변경)
- **아이콘에 레이블/툴팁 필수**: 새로운 컨트롤은 멘탈 모델이 없으므로 아이콘만으로는 부족

**Trade-off**:
- 기능이 많을수록 입력 영역이 무거워져 "채팅"이 아닌 "폼" 느낌 발생
- ChatGPT는 모드 선택(Auto/Fast/Thinking)을 입력창 내에 통합; 기능은 강력하나 신규 사용자에게 혼란 가능
- 최소화된 입력창(Claude Code CLI 래퍼들)은 학습 곡선 낮춤

---

## 5. 레이아웃 구조 (Layout Architecture)

**What**: 사이드바 + 메인 채팅 영역의 2-컬럼 레이아웃. 일부 도구는 채팅 + 아티팩트/코드의 스플릿 패널 채택.

**Why**: 대화 이력 접근성과 현재 대화 집중도 사이의 균형. 긴 대화 세션에서 이전 컨텍스트로 빠르게 전환하는 것이 생산성에 직결된다.

**패턴 변형**:
- **ChatGPT**: 접을 수 있는 좌측 사이드바(대화 목록) + 전체 너비 채팅 영역. 최소주의 원칙
- **Claude.ai**: 좌측 사이드바에 대화 목록 + Projects(관련 대화/문서 묶음) 계층 구조. WhatsApp + Notion 혼합 느낌
- **Claude Code GUI들 (Opcode/CodePilot)**: 3-패널 (파일트리 | 채팅 | 코드/diff). 개발 도구 특화
- **스플릿 아티팩트(ChatGPT Canvas)**: 좌측 채팅 + 우측 아티팩트 편집기. 반복 수정 워크플로에 최적

**Trade-off**:
- 사이드바 고정: 접근성 높으나 좁은 화면에서 채팅 영역 축소
- 사이드바 접기(collapsible): 집중 모드 가능하나 히스토리 접근 마찰 증가
- 스플릿 패널: 코드/문서 작업에 강력하나 순수 대화 UX에서 오버엔지니어링

---

## 6. 정보 밀도와 코드/텍스트 계층 (Information Density & Content Hierarchy)

**What**: 응답 내 마크다운 렌더링, 코드 블록 강조, 헤더/리스트 계층화, 인라인 메타데이터(토큰 수, 모델명, 타임스탬프) 표시 패턴.

**Why**: AI 응답은 일반 채팅보다 정보 밀도가 높다. 구조화 없이 장문 텍스트로 표시되면 스캔하기 어렵다. 코드는 특히 가독성을 위한 특별 처리가 필수.

**패턴**:
- **마크다운 렌더링**: 헤더, 볼드, 이탤릭, 리스트 → 응답의 논리 구조를 시각화
- **코드 블록**: 언어 레이블 + 구문 강조 + 코드 복사 버튼. Claude.ai는 아티팩트로 별도 실행/렌더링 지원
- **메시지 내 메타데이터**: 모델명, 소요 시간, 토큰 수는 개발자 도구에서 중요하나 일반 사용자에게 노이즈. 접어두기 또는 호버로 표시하는 것이 일반적
- **Gemini**: 인용 + 팩트체크 레이어 추가로 신뢰도 표시 차별화

**Trade-off**:
- 마크다운 렌더링 on/off 옵션: 개발자는 raw 텍스트 복사가 편리하나 일반 사용자는 렌더링 선호
- 정보 밀도가 높을수록 스크롤 양 증가; 접기/펼치기(collapsible sections)로 완화 가능

---

## 7. 후속 액션 (Follow-up Actions)

**What**: AI 응답 아래에 위치한 액션 버튼 모음. 복사, 재생성(Regenerate), 편집, 피드백(좋아요/싫어요), 공유 등.

**Why**: 멀티턴 대화에서 이전 응답을 기반으로 반복 수정하는 패턴이 매우 빈번하다. 응답마다 액션을 바로 제공하면 타이핑 부담 없이 후속 작업을 처리할 수 있다.

**패턴**:
- **Regenerate**: 같은 프롬프트로 재생성. ChatGPT는 "2/3" 같은 응답 버전 네비게이션 제공
- **Edit message**: 사용자가 이전 메시지를 수정해 새 브랜치 생성. 대화 분기(branching) UX
- **Copy**: 마크다운 렌더링 없이 raw 텍스트 또는 렌더링 기준 HTML 복사
- **Claude.ai 차별점**: 후속 질문 제안 모듈 제공 — 광범위한 질문 시 선택지를 체크박스로 제공해 타이핑 최소화

**Trade-off**:
- 버튼이 많아질수록 UI 클러터 증가; 호버 시에만 표시하는 패턴으로 완화
- 대화 분기는 강력하나 사용자가 현재 어떤 브랜치에 있는지 혼란 유발 가능

---

## 경쟁사 간 차별점 요약

| 패턴 | ChatGPT | Claude.ai | Claude Code GUI (Opcode 등) | Gemini |
|------|---------|-----------|----------------------------|--------|
| 스트리밍 중 입력 | 가능 (mid-stream) | 불가 | CLI 의존 | 불가 |
| 컨텍스트 관리 | 프로젝트 없음 | Projects (200K 컨텍스트) | 세션/워크스페이스 | Google Workspace 통합 |
| 코드 아티팩트 | Canvas (우측 패널) | Artifacts (렌더링/실행) | 3패널 + diff viewer | 제한적 |
| 아키텍처 | 2-컬럼 (접힘 가능) | 2-컬럼 + 계층 사이드바 | 3-패널 (파일트리 포함) | 앱 내 임베드 |
| 후속 질문 제안 | 제한적 | 체크박스 선택지 제공 | 없음 | 있음 |
| 모드 전환 | Auto/Fast/Thinking (인풋 내) | 없음(모델 선택) | CLI 파라미터 의존 | 없음 |

---

## 핵심 시사점 (Nexus Code 적용 관점)

1. **스트리밍은 필수**: Claude Code CLI 출력을 실시간 스트리밍으로 표시해야 체감 응답성 확보
2. **상태 전환 명확화**: idle → streaming → complete → error 각 상태에 대한 명확한 시각 피드백
3. **입력 영역 단순하게 유지**: Electron 래퍼 특성상 과도한 컨트롤 추가보다 Enter 전송 + Shift+Enter 줄바꿈 + Stop 버튼으로 충분
4. **코드 블록 처리**: Claude Code의 출력은 코드/diff가 많으므로 구문 강조 + 복사 버튼 필수
5. **대화 이력 사이드바**: 세션 목록과 현재 대화 컨텍스트를 분리하는 2-컬럼 레이아웃 적합

---

## 실현성 검토 (Architect)

> 현재 아키텍처: Electron 41 + React 19 + Zustand 5, CLI subprocess via stream-json, HookServer 기반 Permission

### 1. 스트리밍 출력 표시

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `StreamParser`가 `stream_event` → `content_block_delta`를 파싱하여 토큰 단위 `text_chunk` 이벤트를 emit하고, `ipc-bridge`가 `appendTextChunk()`로 Zustand에 누적 중. **이미 구현되어 있다.**
- **필요 사항**: 마크다운 렌더링 중 레이아웃 점프 방지를 위한 `MarkdownRenderer` 최적화 (현재 `react-markdown` 사용 시 매 청크마다 전체 리렌더). `useDeferredValue` 또는 debounce 적용 검토.
- **구현 난이도**: Low (최적화 수준)

### 2. 메시지 턴 구분

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `MessageBubble`이 좌우 정렬 + 배경색 분리 구현 완료. (`isUser ? 'justify-end bg-blue-600' : 'justify-start bg-gray-800'`)
- **필요 사항**: Claude.ai 스타일 좌측 정렬 + 아바타 방식으로 전환하려면 `MessageBubble` 레이아웃 변경. 긴 코드 블록 시 너비 80% 제한이 가독성을 해칠 수 있으므로 assistant 메시지는 전체 너비 옵션 고려.
- **구현 난이도**: Low

### 3. 요청 생명주기 상태 표시

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `SessionStatus` 타입이 `idle | running | waiting_permission | ended | error`를 정의하고, `session-store`에서 상태 전이를 관리 중. Renderer에서 `status`를 구독하여 UI 반영 가능.
- **필요 사항**: `ChatPanel`에서 status별 시각 피드백 (스피너, Stop 버튼, 에러 재시도 CTA) 추가. 현재는 입력 비활성화(`isInputDisabled`)만 처리.
- **구현 난이도**: Low

### 4. 입력 영역 구조

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `ChatInput` 컴포넌트가 textarea + 전송 구현 완료.
- **필요 사항**: IME 사용자를 위한 `Ctrl+Enter` 전송 옵션, 자동 높이 조절 (현재 고정 높이면 추가), Stop 버튼 (status === 'running' 시 표시 + `CANCEL` IPC 호출).
- **구현 난이도**: Low

### 5. 레이아웃 구조

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `AppLayout`이 Sidebar + MainPanel 2-컬럼 구조. `RightPanel`은 MainPanel에 포함되지 않고 별도로 존재하나, 3-패널 확장 가능.
- **필요 사항**: Sidebar 접기(collapsible) 기능, RightPanel 토글. 현재 Sidebar 너비가 고정이므로 resize handle 또는 토글 버튼 추가.
- **구현 난이도**: Low

### 6. 정보 밀도와 코드/텍스트 계층

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `MarkdownRenderer`가 마크다운 렌더링 담당. 코드 블록 구문 강조와 복사 버튼은 라이브러리 추가로 가능.
- **필요 사항**: `react-syntax-highlighter` 또는 `shiki` 추가로 구문 강조, 코드 블록 복사 버튼, 메타데이터(비용, 소요 시간)는 `TurnEndEvent.costUsd/durationMs`에서 이미 수신 중이므로 UI 표시만 추가.
- **구현 난이도**: Low

### 7. 후속 액션

- **실현 가능성**: 보통
- **기술적 제약**: **Copy**는 즉시 가능. **Regenerate**는 동일 프롬프트를 `sendPrompt()`로 재전송하면 되나, CLI가 이전 컨텍스트를 유지하고 있으므로 "동일 질문 재생성"이 아닌 "추가 턴"으로 처리됨. 진정한 Regenerate(이전 응답 폐기 후 재생성)는 CLI `--resume` + 대화 분기 기능이 없으면 불가. **Edit message**(대화 분기)는 CLI가 대화 분기를 지원하지 않으므로 현재 불가능.
- **필요 사항**: Copy 버튼은 `MessageBubble`에 추가. Regenerate는 새 세션 시작 또는 CLI의 대화 분기 지원 대기. 후속 질문 제안은 Claude 응답에서 추출하는 별도 로직 필요.
- **구현 난이도**: Copy Low, Regenerate/Edit Medium~High (CLI 제약)

---

*조사일: 2026-03-27*
