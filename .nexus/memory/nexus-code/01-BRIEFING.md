# 01-BRIEFING.md — nexus-code 프로젝트 진입 브리핑

> **읽기 순서**: `../00-ECOSYSTEM_PRIMER.md` → 이 파일 → `02-DECISIONS.md` → `03-IMPLEMENTATION_GUIDE.md` → `04-OPEN_QUESTIONS.md` → `05-REFERENCES.md`
>
> **세션 메타**: plan session #1, nexus-temp 워크스페이스, 2026-04-10. nexus-code는 이번 세션에서 가장 많은 변화를 받은 프로젝트다.

---

## 이 프로젝트가 무엇인가

nexus-code는 **Nexus 생태계에 최적화된 에이전트 감독자 워크벤치**다.

이전 표현("코드 에이전트 CLI의 GUI 래퍼 + 추가 기능")은 폐기한다. 그 표현은 nexus-code를 다른 도구의 부속품으로 위치시켰다. 실제 역할은 다르다: nexus-code는 Authoring/Execution/Supervision 3층위(Primer §1 참조) 중 **Supervision layer** 전체를 담당한다. Execution layer 세션을 외부에서 spawn·관찰·권한 중재·시각화하는 독립적인 계층이다.

이 재프레이밍은 단순한 마케팅 문구 변경이 아니다. nexus-code가 nexus-core의 read-only consumer로 합류하고, AgentHost 인터페이스를 통해 멀티-하네스를 통합 감독하는 구조적 결정의 귀결이다.

---

## Supervision layer의 이중 성격

nexus-code는 "Supervisor"다. Primer §3.1이 명시한 이중 성격을 정확히 이해해야 한다:

**(a) 세션 관찰자 측면**: Execution layer 세션 프로세스(Claude Code CLI, OpenCode)의 상태, 메시지 스트림, 파일 변경 사항을 읽기 전용으로 외부에서 관찰한다.

**(b) Policy Enforcement Point 측면**: 에이전트가 요청하는 권한(파일 수정, 셸 명령 실행 등)에 대해 승인 또는 거부 결정을 내린다. ApprovalBridge가 Pre-tool-use hook으로 이 결정 지점을 처리한다.

이 이중성은 Claude Code CLI의 비대화형 권한 구조에서 구조적으로 유래한다. 단순 관찰자가 아니라 권한 결정을 실제로 집행하는 지점이라는 점에서 "Supervisor"가 정확한 용어다. **nexus-code의 어떤 새 설계 문서에서도 "Observer"를 사용해서는 안 된다.**

---

## 이번 세션이 Plan #5에 미치는 영향

nexus-code에는 별도의 철학 세션(Plan #5)이 있다. Plan #5는 13개 철학 이슈를 다루며, 현재 T1(민지 페르소나)과 T5(Non-goals 원칙)만 결정된 상태다. T3 이하 11개 이슈는 pending이다.

이번 세션(plan session #1)의 결정들은 Plan #5 T3 재개 시 전제로 이어진다. 특히:

- T5의 "Observer 원칙" 문구는 이번 세션에서 확정된 "Supervisor 이중 성격" 프레임과 충돌한다. **차기 세션에서 T5 재명시가 필요하다.** 이 브리핑을 메모로 기록해 두어야 한다.
- AgentHost 인터페이스 설계, nexus-core consumer 합류, 정체성 재프레이밍은 모두 T3 이하 결정들의 전제가 된다.

---

## 해야 할 것

1. **`.nexus/context/` 업데이트**: `architecture.md`에 3층위 프레임과 nexus-code = Supervision layer 위치 추가. `permission-architecture.md`에서 "Observer 원칙" 문구를 "Supervision 이중 성격"으로 재명시. `session-flow.md`에 AgentHost 인터페이스 언급 추가.

2. **`packages/shared`에 AgentHost 인터페이스 정의**: spawn/observe/approve/reject/dispose 메서드 시그니처를 TypeScript 인터페이스로 초안 작성. 이것이 기존 ProcessSupervisor와 신규 OpenCode adapter의 공통 계약이 된다.

3. **nexus-core read-only consumer 합류**: `packages/shared/package.json`에 `@moreih29/nexus-core`를 devDependency로 추가. `generate-metadata.mjs` 빌드 스크립트를 신규 작성하여 meta.yml/vocabulary를 TypeScript 상수로 inline 출력.

4. **기존 ProcessSupervisor를 AgentHost 구현체로 래핑**: `packages/server/src/adapters/`에 `claude-code-host.ts` 작성. 기존 코드를 제거하지 않고 AgentHost 인터페이스 뒤에 위치시키기만 한다.

5. **`.nexus/memory/plan-5-philosophy-snapshot.md` 업데이트**: 이번 세션 결과가 Plan #5 T3 재개 전제임을 기록. T5 재명시 필요 플래그 추가.

6. **OpenCode adapter 초안 작성 시작**: `packages/server/src/adapters/opencode-host.ts` 신규. HTTP/SSE 경로와 ACP stdio 경로 중 선택은 `04-OPEN_QUESTIONS.md` 참조.

---

## 하지 말 것

1. **`@anthropic-ai/claude-agent-sdk` 도입 금지**: API key 전용. 구독제 사용자(민지 페르소나) PMF 불가. Primer §4.2.
2. **ProcessSupervisor + stream-json 모델 제거 또는 교체 금지**: 구독제 호환 Claude Code 감독의 유일 경로. Primer §4.3.
3. **ACP 단일 표준으로 통합 감독 시도 금지**: Claude Code의 ACP 어댑터는 Agent SDK 기반. Primer §4.4.
4. **"Observer" 용어를 새 설계 문서에서 사용 금지**: 역사적 언급(기존 문서 수정 맥락)에서만 허용.
5. **nexus-core에 runtime 코드 기여 금지**: read-only consumer. 쓰기 권한 없음.
6. **에이전트 카탈로그 편집 UI 추가 금지**: 표시만 허용. 에이전트 정의 편집은 Plugin boundary 원칙 위반.

---

## 현재 코드베이스 스냅샷

- **모노레포 구조**: `packages/{shared, server, web, electron}`, Bun 기반
- **서버**: Hono + SSE + Pre-tool-use hook (ApprovalBridge)
- **데이터**: SQLite SoT (Source of Truth)
- **의존성 방향**: Electron → Web → Server → Shared (4-layer)
- **기존 핵심 자산**: ProcessSupervisor, stream-json 파싱, ApprovalBridge (모두 보존 대상)

---

*이 파일은 plan session #1 (2026-04-10) 결과를 반영한다. Plan #5 T3 재개 시 이 브리핑 세트 전체가 전제 자료로 사용된다.*
