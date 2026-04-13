# Backlog — 미해결 항목

> plan session #1 (2026-04-10) + Plan #5 잔여분 + Plan #6 결정 반영 (2026-04-13).

## 미결 설계 결정

### OpenCode adapter 경로 선택 (Phase 3 미결)

두 경로 중 택 1:
- **경로 A** (`opencode serve` + HTTP/SSE): E2 실험으로 동작 확인됨. HTTP/REST 기반으로 디버깅 용이.
- **경로 B** (`opencode acp` + stdio JSON-RPC): ACP 오픈 표준. E4 미완료로 실제 동작 미검증.

둘 다 구독제 호환. 경로 A가 증거 충분. **Phase 3 공식 착수 트리거 기반 판정.**

### nexus-core consumer 관계

Plan #5 (2026-04-12) 결정: **제거됨**. nexus-code는 Supervision layer로서 CONSUMING.md가 정의하는 consumer가 아님. devDep, 빌드 스크립트, generated 코드 전량 삭제. 향후 UI에서 에이전트 메타데이터가 필요해지면 최소 범위로 재연결.

### 멀티-하네스 동시 감독

Claude Code + OpenCode 세션 동시 spawn·관찰 시: sessionId namespace, UI 통합 방식, 이벤트 스트림 합류 설계 필요. OpenCode adapter 완성 전까지 시기상조.

### agent-host-registry 신설 보류 (Plan #6 I3)

현재 단일 참조(`app.ts:63`). Phase 3 OpenCode 진입 트리거 기반 판정 (파일 1개+라인 3-4 비용). `app.ts`에 "Phase 3 registry로 교체 예정" 주석 명시. Phase 3 착수 시 재평가.

### Tauri 런타임 재평가 (Plan #6 I4)

POC 결과 blocker 0건. Electron 잠정 유지. 재평가 trigger 4개 중 2개 이상 충족 시 새 plan 세션. 상세: `.nexus/context/philosophy.md` §Tauri 런타임 재평가 Trigger + `.nexus/memory/tauri-poc-report.md`

---

## Plan #5 잔여 — 11개 이슈

T1(페르소나), T5(Non-goals) 결정 완료 → `.nexus/context/philosophy.md`에 반영됨.

### 묶음 1 — 가치 제안 (owner: strategist)
- **T3** 핵심 가치 제안 — 다음 우선
- T2 경쟁 대비 차별화 포지셔닝
- T4 로드맵 우선순위
- Trigger: Phase 2 완료 (AgentHost 와이어링 app.ts 완성, 커밋 #4b 이후)

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
- Trigger: Phase 3 완료 (기존 "Phase 3 완료" 기준 유지 — Plan #6 I1-I3 구현이 선행 검증 역할)

### 묶음 3 — 디자인 (owner: designer)
- D1 정보 구조(IA) 우선순위
- D4 미팅 워크플로우 UI
- D2 인터랙션 원칙
- D3 시각 언어
- Trigger: 묶음 1 완료 후

---

## 신규 미결 항목 (Plan #6 분리)

### Playwright E2E suite 복구 (별도 이슈)

현재 E2E 테스트 3개 전부 `test.skip`. 설치·config·mock 미구축 상태. Plan #6 I3에서 E2E 복구는 현재 plan scope 밖으로 분리됨. dogfood 검증으로 대체 중. 별도 이슈로 추적.

### pre-existing 122 fail 정리 (별도 이슈)

`better-sqlite3` 바인딩 이슈 + `vi.mocked` 환경 설정 불일치로 인한 기존 실패 122건. Plan #6 I3 회귀 방지 범위 밖으로 분리. 별도 이슈로 추적.

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
