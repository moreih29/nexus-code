# 도구 호출 시각화 레퍼런스

VS Code Copilot Chat을 중심으로 한 도구 호출 시각화 UI 패턴 분석. Zed, JetBrains AI Assistant 비교 포함.

---

## 핵심 패턴 1: 인라인 툴 카드 (Collapsed-by-Default)

**What:** 도구 호출은 채팅 대화 흐름 안에 인라인으로 삽입된 요약 라인으로 표시된다. 기본적으로 접혀(collapsed) 있으며, 클릭하면 입력/출력 전체가 펼쳐진다.

**VS Code 구현:** 도구 요약 라인("Used `read_file` · 3 results")이 채팅 메시지 사이에 인라인 삽입됨. 상단에 chevron(›) 아이콘으로 확장 가능하며, 확장 시 도구 입력 파라미터와 출력 페이로드가 노출된다.

**Why:** 대부분의 도구 호출은 사용자가 검토할 필요 없는 성공 케이스다. 기본 접힘으로 대화의 가독성을 유지하면서, 필요 시 전체 context를 확인할 수 있는 경로를 열어둔다.

**Trade-off:**
- (+) 대화 흐름 방해 최소화
- (+) 정보 밀도 제어 가능
- (-) 오류 발생 시 요약 라인만 보면 원인을 파악하기 어려움
- (-) 접힘 상태에서는 진행 중인 작업의 맥락 파악이 불가

---

## 핵심 패턴 2: 계층적 승인 흐름 (Multi-Level Confirmation)

**What:** 도구 실행 전 확인 다이얼로그가 표시되며, 사용자는 허용 범위를 4단계 중 선택한다: 이번 한 번 / 현재 세션 / 현재 워크스페이스 / 항상 허용.

**VS Code 구현:**
- 읽기 전용 내장 도구(파일 읽기 등)는 자동 승인
- 쓰기/실행 도구(터미널 명령, 파일 수정)는 확인 필요
- 확인 다이얼로그에서 chevron으로 도구 입력 파라미터 확장 및 편집 후 Allow 실행 가능
- 웹 도구(`#fetch`)는 요청/응답 2단계 승인 (prompt injection 방지)
- `chat.tools.terminal.enableAutoApprove` 설정으로 조직 수준 자동 승인 가능

**Why:** 보안 위험도에 따른 차등 승인으로 마찰과 안전성을 균형 맞춤. 터미널 명령은 돌이키기 어려운 부작용이 있어 명시적 승인 필수.

**Trade-off:**
- (+) 실수로 인한 파괴적 작업 방지
- (+) 사용자가 도구 입력을 검토·수정할 수 있음
- (-) 반복적 승인으로 인한 피로도(승인 피로)
- (-) YOLO 모드 수요 발생 → 별도 자동 승인 설정 필요

---

## 핵심 패턴 3: 터미널 명령 인라인 출력 (Progressive Disclosure)

**What:** 터미널 명령 실행 결과를 채팅 내에서 단계적으로 공개한다. 기본은 명령 요약만 표시하고, "Show Output (>)" 버튼으로 인라인 출력 확장, "Show Terminal" 버튼으로 통합 터미널에서 전체 출력 확인.

**VS Code 구현:**
- 실행 중: 명령 라인 + "Continue in Background" 버튼 표시
- 완료: 명령 라인 + 출력 요약 + Show Output / Show Terminal 버튼
- 뷰 타이틀 바의 "Undo Last Edit" 컨트롤로 변경 취소 가능

**Why:** 터미널 출력은 대부분 긴 텍스트다. 채팅 흐름 안에 전체 출력을 삽입하면 대화 맥락이 매몰된다. 3단계 공개(요약 → 인라인 → 터미널)로 사용 패턴에 따른 적절한 정보량 제공.

**Trade-off:**
- (+) 채팅 대화 가독성 유지
- (+) 긴 출력도 원하는 만큼 확인 가능
- (-) 중요 오류가 숨겨질 수 있음 (출력 확장해야 보임)
- (-) 컨텍스트 전환 비용 (채팅 ↔ 터미널)

---

## 핵심 패턴 4: 상태 타임라인과 이벤트 로그 (Debug View)

**What:** 별도 디버그 패널에서 에이전트 세션의 모든 이벤트를 타임스탬프 기반 크로노로지컬 로그로 표시한다.

**VS Code 구현 (Chat Debug View):**
- 이벤트 유형 필터: Tool Calls / LLM Requests / Discovery
- 각 이벤트: 타임스탬프 + 이벤트 타입 + 요약 → 클릭으로 전체 페이로드 확장
- LLM 요청: system prompt + user prompt + context 전체 확인
- 도구 호출: 입력 파라미터 + 출력 결과 전체 확인
- 플랫 리스트 ↔ 서브에이전트 그룹 트리뷰 전환 가능
- Agent Flow Chart: 이벤트 시퀀스를 다이어그램으로 시각화 (pan/zoom, 노드 클릭 상세)

**Why:** 인라인 채팅 뷰는 사용자 친화적이지만 복잡한 에이전트 워크플로우 디버깅에는 불충분하다. 별도 디버그 뷰로 개발자/파워유저 니즈를 분리.

**Trade-off:**
- (+) 복잡한 에이전트 체인 디버깅 가능
- (+) 메인 채팅 UI와 오버레이 없이 분리된 공간
- (-) 일반 사용자에게는 정보 과부하
- (-) 채팅 뷰와 디버그 뷰 간 컨텍스트 동기화 필요

---

## 핵심 패턴 5: diff 뷰 통합과 파일 변경 요약

**What:** 에이전트가 파일을 수정한 후, 변경된 파일 목록과 diff를 에디터 오버레이 형태로 표시한다. 파일별 수락/거부 컨트롤 제공.

**VS Code 구현:**
- 변경된 파일 목록이 채팅 메시지 하단에 접힌 형태로 표시
- 에디터 오버레이로 인라인 diff (Keep / Undo 컨트롤)
- 뷰 타이틀 바의 "Undo Last Edit" 전체 취소
- 민감 파일(설정 파일 등) 수정 시 `chat.tools.edits.autoApprove`로 별도 확인

**JetBrains 구현 (비교):**
- "Show Diff" 버튼으로 파일 diff 뷰어 오픈
- Accept / Discard / Create Patch (.patch 파일 생성) 3가지 액션
- 멀티파일 제안 시 파일 목록 → 개별 diff 리뷰 → 일괄 적용 흐름

**Why:** 파일 수정은 가장 파괴적인 도구 작업. 변경 후 시각적 검토 게이트를 제공함으로써 에이전트 결과물을 사람이 검증하는 안전 루프를 형성.

**Trade-off:**
- (+) 잘못된 변경을 적용 전에 포착 가능
- (+) 파일별/라인별 세밀한 수락 제어
- (-) 리뷰 단계가 추가되어 빠른 이터레이션 저해
- (-) 대규모 리팩토링 시 diff 뷰 자체가 압도적

---

## 핵심 패턴 6: 실시간 스트리밍 + 체크포인트 (Zed 방식)

**What:** 도구 실행과 파일 편집 결과를 토큰 단위로 실시간 스트리밍하며 표시한다. 에디터 안에서 에이전트 커서가 실시간으로 이동하고, 체크포인트(Restore Checkpoint)로 이전 상태로 복구 가능.

**Zed 구현:**
- CRDT 기반 버퍼에 스트리밍 diff 적용 → 토큰 단위 실시간 편집 표시
- 에이전트 커서 120fps 추적
- 파일 변경 완료 후 Accordion Summary: "N개 파일, M줄 변경"
- Review Changes 버튼 → 멀티버퍼 diff 탭 (hunk 단위 Accept/Reject)
- "Restore Checkpoint" 버튼으로 에이전트 편집 이전 상태로 복구
- `agent.single_file_review`로 파일별 diff 토글 가능
- 도구 사용 중 스트리밍 인디케이터: "어떤 도구를 사용 중인지 표시"

**Why:** 실시간 피드백은 에이전트가 의도를 이해하고 있는지 즉각 확인하고 잘못된 방향을 조기에 중단할 수 있게 한다. 체크포인트는 무거운 diff 리뷰 없이도 안전하게 실험 가능.

**Trade-off:**
- (+) 에이전트 진행 방향을 즉각 파악
- (+) 무거운 리뷰 게이트 없이 가벼운 복구 제공
- (-) 스트리밍 중 화면이 계속 변경되어 집중 방해 가능
- (-) 에디터 내 실시간 변경은 다른 작업과 충돌 가능

---

## 핵심 패턴 7: 중앙화 도구 관리 (Tool Picker & Approval Manager)

**What:** 채팅 입력창 옆의 도구 picker로 세션에서 사용할 도구를 on/off 관리하며, Command Palette의 "Manage Tool Approval"로 MCP 서버 및 확장 도구의 승인 상태를 한 곳에서 관리한다.

**VS Code 구현:**
- 채팅 입력창 `#` 타입으로 도구 직접 참조
- 도구 picker UI로 시나리오별 도구 활성화/비활성화
- "Chat: Manage Tool Approval" 커맨드: Quick Pick으로 모든 도구를 소스(MCP 서버/확장)별 그룹화하여 표시
- `github.copilot.chat.agent.autoApproveTools` 설정으로 특정 도구 자동 승인 목록 관리

**Why:** 도구가 많아질수록 개별 승인 다이얼로그만으로는 관리가 어려워진다. 중앙화된 도구 관리 UI로 전체 권한 상태의 가시성 확보.

**Trade-off:**
- (+) 도구 권한 상태의 중앙 가시성
- (+) 세션/워크스페이스별 도구 구성 재사용 가능
- (-) 도구 수가 적을 때는 오버엔지니어링
- (-) 설정과 런타임 승인 다이얼로그가 분리되어 일관성 혼동

---

## IDE별 도구 시각화 비교

| 항목 | VS Code Copilot | Zed | JetBrains AI |
|------|----------------|-----|--------------|
| 도구 카드 위치 | 채팅 인라인 | 에이전트 패널 | 채팅 사이드바 |
| 기본 상태 | 접힘 (요약 라인) | 스트리밍 실시간 | 접힘 |
| 파일 diff | 에디터 오버레이 | 멀티버퍼 탭 | 별도 diff 뷰어 |
| 승인 모델 | 4단계 범위 선택 | 없음 (체크포인트 기반) | Accept/Discard |
| 상태 타임라인 | 별도 Debug View | 에이전트 패널 내 로그 | 제한적 |
| 복구 메커니즘 | Undo Last Edit | Restore Checkpoint | Discard/Patch |
| 실시간 피드백 | 제한적 | 토큰 단위 스트리밍 | 제한적 |

---

## D3 결정(하이브리드 도구 UX)과의 연관성

조사 결과에서 D3 하이브리드 도구 UX에 직접 연관되는 핵심 인사이트:

1. **인라인 + 별도 패널의 이중 구조가 표준**: 메인 채팅에는 요약 카드, 파워유저에게는 별도 디버그/로그 패널. 하이브리드 UX 설계 시 두 레이어 모두 고려 필요.

2. **도구 카드는 기본 접힘이 정답**: 사용자가 대부분의 도구 호출에 관심 없음. 실패/중요 도구만 시각적으로 강조하는 전략이 효과적.

3. **승인 피로도가 핵심 UX 문제**: VS Code도 YOLO 모드 요구가 계속 발생. 하이브리드 UX에서는 위험도 기반 자동 승인 + 명시적 확인 조합이 필수.

4. **체크포인트 패턴(Zed)이 diff 리뷰보다 낮은 마찰**: 변경 전 승인보다 변경 후 복구가 더 유연한 안전망 제공. 도구 UX에서 "undo-first" 설계 고려 가치 있음.

5. **터미널 출력의 Progressive Disclosure**: 채팅 맥락 보존을 위해 3단계 공개(요약 → 인라인 확장 → 외부 패널)가 효과적인 패턴.

---

## 참고 자료

- [Use agent mode in VS Code](https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode)
- [Use tools with agents](https://code.visualstudio.com/docs/copilot/agents/agent-tools)
- [Chat Debug View](https://code.visualstudio.com/docs/copilot/chat/chat-debug-view)
- [Introducing GitHub Copilot agent mode (preview)](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode)
- [Agent mode: available to all users and supports MCP](https://code.visualstudio.com/blogs/2025/04/07/agentMode)
- [GitHub Copilot in VS Code August release (v1.104)](https://github.blog/changelog/2025-09-12-github-copilot-in-vs-code-august-release-v1-104/)
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel)
- [Agentic Development in Zed vs VS Code](https://blog.herlein.com/common/vscode-vs-zed/)
- [JetBrains AI Assistant Update 2025.2](https://blog.jetbrains.com/ai/2025/08/jetbrains-ai-assistant-2025-2/)

---

## 실현성 검토 (Architect)

> 현재 아키텍처: ToolRenderer.tsx 14개 도구별 카드, CollapsibleResult, HookServer manual 모드 Permission, PluginHost file-watch + AgentTracker broadcast

### 패턴 1: 인라인 툴 카드 (Collapsed-by-Default)

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `ToolCard` 컴포넌트가 이미 인라인 카드 구조. `CollapsibleResult`가 10줄 초과 시 접기 제공. 다만 카드 자체의 접기(도구명 한 줄만 표시)는 미구현.
- **필요 사항**: `ToolCard`에 전체 접기/펼치기 상태 추가. 기본 접힘 + 클릭 시 확장. 에러 발생 시 자동 펼침 로직.
- **구현 난이도**: Low

### 패턴 2: 계층적 승인 흐름 (Multi-Level Confirmation)

- **실현 가능성**: 보통
- **기술적 제약**: 현재 Permission 흐름은 **이번 한 번** 허용/거부만 지원. HookServer → PermissionHandler → PermissionCard → RESPOND_PERMISSION IPC로 단일 요청-응답 구조. "현재 세션 동안 허용" / "항상 허용"은 PermissionHandler에 화이트리스트 메모리 추가 + settings.json 연동 필요.
- **필요 사항**: `PermissionHandler`에 세션 레벨 캐시 (Map<toolName, 'allow'|'deny'>), PermissionCard UI에 범위 선택 드롭다운, settings.json 연동으로 영구 허용 목록 관리.
- **구현 난이도**: Medium

### 패턴 3: 터미널 명령 인라인 출력 (Progressive Disclosure)

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `BashRenderer`가 명령어 + `CollapsibleResult`로 2단계 공개 구현. 3단계(외부 터미널 패널)는 RightPanel에 터미널 탭 추가로 가능.
- **필요 사항**: `CollapsibleResult` 개선 — 요약 라인(exit code + 출력 줄 수) + 인라인 확장 + "Show in Panel" 버튼으로 RightPanel에 전체 출력 표시. `BashRenderer`에 `description` 필드 활용한 요약 라인 강화.
- **구현 난이도**: Low

### 패턴 4: 상태 타임라인과 이벤트 로그 (Debug View)

- **실현 가능성**: 높음
- **기술적 제약**: 없음. 현재 `AgentTimeline` 컴포넌트가 RightPanel Timeline 탭에서 에이전트별 도구 호출 이력을 표시 중. `AgentTracker`가 HookServer pre-tool-use 이벤트를 수집하여 broadcast.
- **필요 사항**: 이벤트 유형 필터 UI 추가, 타임스탬프 표시, LLM 요청 로그 추가 (현재 tool_call만 추적). 플랫 리스트 ↔ 에이전트 그룹 토글. Flow Chart 시각화는 별도 라이브러리(예: `reactflow`) 필요.
- **구현 난이도**: 기본 확장 Low, Flow Chart Medium

### 패턴 5: diff 뷰 통합과 파일 변경 요약

- **실현 가능성**: 보통
- **기술적 제약**: **핵심 제약** — stream-json에서 `tool_call` 이벤트는 **실행 후** 도착한다. 즉 Edit/Write 도구가 이미 파일을 수정한 후에 Renderer가 이벤트를 수신. **실행 전 승인/거부는 HookServer manual 모드에서만 가능**. manual 모드 시 HookServer가 Edit/Write pre-tool-use를 가로채고, PermissionCard에서 diff UI를 보여준 후 Allow/Deny로 제어 가능.
- **필요 사항**: (1) `PermissionCard`를 도구별로 분기 — Edit/Write 요청 시 diff 뷰 렌더링 (old_string/new_string 또는 file_path/content 표시). (2) 실행 후 변경 요약은 `EditRenderer`/`WriteRenderer`에 이미 구현되어 있으므로, 파일별 변경 목록 집계 뷰를 RightPanel에 추가. (3) Keep/Undo는 CLI가 git checkout 또는 자체 복구를 지원해야 하므로 Electron 측에서 파일 백업/복원 로직 필요.
- **구현 난이도**: diff 표시 Medium, Keep/Undo High (파일 백업 인프라 필요)

### 패턴 6: 실시간 스트리밍 + 체크포인트 (Zed 방식)

- **실현 가능성**: 낮음
- **기술적 제약**: **근본적 제약** — Nexus Code는 에디터가 아닌 채팅 래퍼. CRDT 버퍼 기반 실시간 편집 표시와 에이전트 커서 추적은 에디터 코어가 필요. 현재 아키텍처에서 파일 편집의 토큰 단위 스트리밍은 불가능 (CLI가 완료된 tool_call만 출력). 체크포인트(파일 상태 스냅샷)는 git stash/commit 기반으로 Electron에서 구현 가능하나, 에디터 수준의 실시간 피드백과는 다른 수준.
- **필요 사항**: 체크포인트만 구현 시 — 세션 시작 시 git stash 또는 작업 디렉토리 스냅샷 + "Restore" 버튼. 실시간 편집 스트리밍은 아키텍처 전환(에디터 통합) 필요.
- **구현 난이도**: 체크포인트 Medium, 실시간 편집 스트리밍 Very High (아키텍처 변경)

### 패턴 7: 중앙화 도구 관리 (Tool Picker & Approval Manager)

- **실현 가능성**: 보통
- **기술적 제약**: 현재 `PermissionHandler`의 `AUTO_APPROVE_TOOLS`와 `AUTO_APPROVE_BASH_PATTERNS`가 하드코딩. 동적 관리 UI를 만들려면 이 목록을 settings.json 연동으로 변경하고, Renderer에서 관리 UI 제공 필요.
- **필요 사항**: (1) `SettingsModal`에 도구 권한 관리 섹션 추가. (2) settings.json의 `permissions.allow/deny` 배열을 `PermissionHandler`가 런타임에 읽도록 연동. (3) CLI의 `--permission-prompt-tool`과 settings.json 간 동기화 보장.
- **구현 난이도**: Medium
