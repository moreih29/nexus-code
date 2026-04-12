# Backlog — 미해결 항목

> plan session #1 (2026-04-10) + Plan #5 잔여분 통합.

## 미결 설계 결정

### OpenCode adapter 경로 선택

두 경로 중 택 1:
- **경로 A** (`opencode serve` + HTTP/SSE): E2 실험으로 동작 확인됨. HTTP/REST 기반으로 디버깅 용이.
- **경로 B** (`opencode acp` + stdio JSON-RPC): ACP 오픈 표준. E4 미완료로 실제 동작 미검증.

둘 다 구독제 호환. 경로 A가 증거 충분.

### nexus-core consumer 관계

Plan #5 (2026-04-12) 결정: **제거됨**. nexus-code는 Supervision layer로서 CONSUMING.md가 정의하는 consumer가 아님. devDep, 빌드 스크립트, generated 코드 전량 삭제. 향후 UI에서 에이전트 메타데이터가 필요해지면 최소 범위로 재연결.

### 멀티-하네스 동시 감독

Claude Code + OpenCode 세션 동시 spawn·관찰 시: sessionId namespace, UI 통합 방식, 이벤트 스트림 합류 설계 필요. OpenCode adapter 완성 전까지 시기상조.

---

## Plan #5 잔여 — 11개 이슈

T1(페르소나), T5(Non-goals) 결정 완료 → `.nexus/context/philosophy.md`에 반영됨.

### 묶음 1 — 가치 제안 (owner: strategist)
- **T3** 핵심 가치 제안 — 다음 우선
- T2 경쟁 대비 차별화 포지셔닝
- T4 로드맵 우선순위
- Trigger: Phase 2 완료

살아남은 tagline 후보:
- ε: "See what your agents are doing."
- ν: "Your plugins run the agents. Nexus Code shows you everything."
- μ: "Your agent fleet, in full view."

기각됨: α(안전성 축 폐기), λ(사고 방지 뉘앙스), δ(통제 주체 혼동)

### 묶음 2 — 아키텍처 원칙 (owner: architect)
- S1 계층 경계와 의존 원칙
- S2 상태 소재 원칙
- S3 외부 경계 격리 (헤드리스 보안 포함)
- S4 오케스트레이션 기능 배치 전략
- Trigger: Phase 3 완료

### 묶음 3 — 디자인 (owner: designer)
- D1 정보 구조(IA) 우선순위
- D4 미팅 워크플로우 UI
- D2 인터랙션 원칙
- D3 시각 언어
- Trigger: 묶음 1 완료 후

---

## 경쟁 매트릭스 (T1 조사 결과)

| 기능 | Nexus Code | Nimbalyst | Cursor | Zed | Opcode |
|------|:-:|:-:|:-:|:-:|:-:|
| 멀티 세션 병렬 | O | O | O | O | X |
| 서브에이전트 추적 | O | ?(주장만) | X | X | X |
| 내장 브라우저 | O | ? | X | X | X |
| 미팅 워크플로우 1급 | O | O(Kanban) | X | X | X |

유일 우위 후보: (1) 내장 브라우저, (2) 서브에이전트 구체 가시화, (3) [plan]→[d]→[run] 시각화, (4) 에이전트 중심 IA

주시 대상: manaflow-ai/cmux, agent-flow, claude-devtools
