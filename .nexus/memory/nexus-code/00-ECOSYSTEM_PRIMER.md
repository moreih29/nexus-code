# 00-ECOSYSTEM_PRIMER.md — Nexus 생태계 공통 헌법

> **이 문서의 유효 범위**: 4개 프로젝트(nexus-core, claude-nexus, opencode-nexus, nexus-code) 전체에 동일 내용으로 배포되는 canonical primer다. 각 프로젝트의 LLM은 이 문서를 먼저 읽은 뒤 해당 프로젝트의 브리핑 세트(01-BRIEFING.md ~ 05-REFERENCES.md)로 넘어간다.
>
> **세션 메타**: plan session #1, nexus-temp 워크스페이스, 2026-04-10. 주제 "Nexus 생태계 공통 철학과 구조 정립". 5개 Issue 결정 완료.

---

## §0 이 문서의 정체와 독자

이 문서는 Nexus 생태계의 공통 헌법이다. 특정 프로젝트에 종속되지 않으며, 4개 레포지토리 모두에서 동일하게 읽힌다.

독자는 각 프로젝트의 세션을 처음 시작하는 LLM이다. 이 문서만으로 생태계 전체 구조, 고정 제약, 핵심 결정을 파악할 수 있어야 한다. 이전 대화 맥락이나 외부 파일에 의존하지 않는다.

이 문서를 읽은 뒤 반드시 해당 프로젝트의 브리핑 세트를 순서대로 읽을 것:
`01-BRIEFING.md` → `02-DECISIONS.md` → `03-IMPLEMENTATION_GUIDE.md` → `04-OPEN_QUESTIONS.md` → `05-REFERENCES.md`

---

## §1 Nexus 생태계 3층위 멘탈 모델

### §1.1 Authoring layer — nexus-core

nexus-core는 프롬프트, neutral metadata, vocabulary를 정의하는 공유 자산이다. 집행 semantics를 포함하지 않는다. claude-nexus, opencode-nexus, nexus-code 모두가 이를 읽기 전용(read-only)으로 소비한다.

nexus-core가 관리하는 항목: 에이전트 정의 파일(id, name, description, category, tags, capabilities, resume_tier, model_tier), vocabulary 파일(capabilities, categories, resume-tiers, tags). `vocabulary/tags.yml`은 skill 태그([plan], [run], [sync])와 inline 액션 태그([d], [m], [m:gc], [rule], [rule:*])를 모두 canonical하게 정의하는 단일 소스다.

### §1.2 Execution layer — claude-nexus, opencode-nexus

claude-nexus와 opencode-nexus는 각각 Claude Code, OpenCode 하네스 내부에서 에이전트를 조립·디스패치하고, 권한을 집행하며, 태스크 파이프라인을 소유한다. 둘은 nexus-core의 동등한 소비자다(parent-child 아님, sibling).

### §1.3 Supervision layer — nexus-code

nexus-code는 Execution layer의 세션 프로세스를 외부에서 spawn·관찰·권한 중재·시각화하는 계층이다. Execution layer를 "감독하는 호스트의 호스트(host of host)" 위치에 있다.

### §1.4 3층위의 용도 — 경계 주의

이 3층위 프레임은 **내부 아키텍처 문서 전용**이다. scope 판단 규칙이 아니며, 그 역할은 각 프로젝트 고유의 boundary 원칙(예: Plugin boundary 원칙)이 상위에 있다. 외부 포지셔닝 문서(README, landing page)에는 이 용어가 등장하지 않는다(→ §7 참조).

---

## §2 고정 관계 모델

### §2.1 Sibling 관계

claude-nexus와 opencode-nexus는 sibling이다. 계층 관계가 아니며, nexus-core를 동등하게 소비한다. 어느 한쪽이 다른 쪽을 관리하거나 의존하지 않는다.

### §2.2 Bidirectional flip 모델

작성자는 주력 하네스를 시간에 따라 전환할 수 있다(claude-nexus → opencode-nexus 또는 반대). 이 flip의 대상은 "prompt 소유권의 이동"이며, nexus-core가 canonical source로 중재한다. flip은 Execution layer 내부에서만 발생한다.

### §2.3 Supervision은 flip 외부

nexus-code는 flip 모델의 당사자가 아니다. 여러 Execution layer 세션을 동시에 감독할 수 있는 별도 층위에 위치한다.

### §2.4 nexus-core의 canonical 역할

nexus-core는 생태계 전체에서 프롬프트, neutral metadata, vocabulary 정의의 유일한 canonical source다. 어떤 프로젝트도 이 정의를 자체적으로 재정의하지 않는다.

---

## §3 용어 고정

### §3.1 Supervisor — nexus-code의 이중 성격

nexus-code는 "Supervisor"다. 이전에는 "Observer"로 표현되었으나 실제로는 이중 성격을 가진다:

- **(a) 관찰자 측면**: 세션 상태, 메시지 스트림, 파일 변경 사항을 읽기 전용으로 관찰한다.
- **(b) Policy Enforcement Point 측면**: 에이전트가 요청하는 권한(파일 수정, 쉘 명령 실행 등)에 대해 승인 또는 거부 결정을 내린다.

이 이중성은 Claude Code CLI의 비대화형 권한 구조에서 구조적으로 유래한다. Claude Code CLI는 권한 요청→승인→실행 흐름을 대화형으로 이을 수 없는 구조이기 때문에, 외부 감독자(nexus-code)가 ApprovalBridge를 통해 이 결정 지점을 처리한다.

### §3.2 HOW / DO / CHECK — 에이전트 카테고리

에이전트는 세 카테고리로 분류된다:

- **HOW**: 분석·자문. architect, designer, postdoc, strategist. 깊은 맥락 유지가 중요.
- **DO**: 실행. engineer, writer, researcher. 산출물(artifact) 단위로 작업.
- **CHECK**: 검증. tester, reviewer. 항상 fresh한 관점에서 검사.

에이전트 간 직접 통신은 없다. 모든 조율은 Lead를 통해 이루어진다(Lead-mediated coordination).

### §3.3 resume_tier — 세션 지속성 구분

에이전트의 세션 지속성은 세 티어로 구분된다:

- **persistent**: 세션 전체 지속. HOW 카테고리 + researcher. 맥락 누적이 핵심 자산.
- **bounded**: artifact 단위 지속. engineer, writer. 특정 산출물 완성 후 종료.
- **ephemeral**: 항상 fresh하게 시작. tester, reviewer. 이전 맥락 없이 독립 검증.

이론 근거: persistence-surface-theory(reasoning surface vs artifact surface).

### §3.4 capability abstraction

추상 capability 문자열(예: `no_file_edit`, `no_task_create`, `no_task_update`, `no_shell_exec`)을 각 하네스가 자기 tool namespace로 resolve한다. 이 추상화가 nexus-core를 harness-neutral한 공유 자산으로 만드는 핵심 메커니즘이다.

---

## §4 결정적 제약 — 바꾸지 말 것

### §4.1 Claude Pro/Max 구독제 호환이 필수 조건

nexus-code의 대상 페르소나는 Claude Pro/Max 구독제 사용자다. API key 기반 경로는 대안이 아니라 배제 대상이다. 모든 설계 결정은 이 제약을 전제로 평가된다.

### §4.2 Anthropic Agent SDK 경로는 금지

`@anthropic-ai/claude-agent-sdk`는 API key 전용이다. Anthropic 공식 문서는 "claude.ai login이나 rate limits를 제3자 제품에서 사용하는 것을 허용하지 않는다"고 명시한다. Agent SDK 기반 설계는 구독제 사용자를 지원할 수 없으므로, 이 경로를 전제로 한 설계 방향은 채택될 수 없다.

### §4.3 ProcessSupervisor + stream-json은 핵심 자산

nexus-code의 기존 Claude Code CLI spawn + stream-json 파싱 + ApprovalBridge 모델은 우회로가 아니다. 구독제 사용자가 Claude Code 세션을 외부에서 감독할 수 있는 유일한 경로이며, 보존해야 할 핵심 자산이다.

### §4.4 ACP로 Claude Code + OpenCode 통합 감독은 현재 불가능

Agent Client Protocol(ACP, Zed 주도)은 독립 오픈 표준이며 OpenCode는 native 지원한다. 그러나 Claude Code의 ACP 어댑터는 Agent SDK 기반으로 재구성되어 구독제 호환이 아니다. 따라서 ACP 단일 표준으로 두 하네스를 통합 감독하는 경로는 현재 가능하지 않다.

---

## §5 완화된 원칙 — 경직되지 말 것

### §5.1 Forward-only schema 완화

"Phase 1에서는 breaking change 금지"를 엄격하게 적용하지 않는다. 1인 dogfooding 맥락에서는 완벽한 사전 방어보다 실제 문제를 경험하며 대응 전략을 학습하는 것이 가치 있다. breaking change 발생 시 대응 방식: semver major bump + CHANGELOG.md에 "Consumer Action Required" 섹션 추가.

### §5.2 Phase 진입 시점 유연성

Phase 2 trigger 조건은 참고 지표일 뿐 엄격한 게이트가 아니다. 작성자 판단으로 조기 전환 가능하다.

---

## §6 세션 #1 결정 사항 — 5개 압축 요약

**Issue #1 — 통합 멘탈 모델**: Authoring(nexus-core) / Execution(claude-nexus ↔ opencode-nexus sibling) / Supervision(nexus-code) 3층위를 내부 아키텍처 문서 전용 프레임으로 확정. bidirectional flip은 Execution layer 2-way 고정, Supervision은 flip 외부. nexus-code는 Observer가 아닌 Supervisor — 세션 관찰자 + Policy Enforcement Point 이중 성격으로 확정.

**Issue #2 — nexus-core 범위 재검토**: nexus-core는 "프롬프트 + neutral metadata + vocabulary" 정의 역할을 유지. nexus-code를 read-only consumer로 추가. ACP vocabulary는 편입하지 않는다(구독제 생태계 밖). nexus-code의 정체성이 "코드 에이전트 CLI의 GUI 래퍼"에서 "Nexus 생태계에 최적화된 에이전트 감독자 워크벤치"로 예리해짐.

**Issue #3 — 레포 구조**: 4개 독립 레포 유지(nexus-core, claude-nexus, opencode-nexus, nexus-code). 3층위 물리적 분리가 개념과 정합. forward-only schema 원칙을 완화(§5.1). breaking change 발생 시 semver major bump + CHANGELOG.md "Consumer Action Required"로 대응.

**Issue #4 — 공통 어휘·명명**: nexus-core에 `vocabulary/tags.yml` 추가 — skill 태그와 inline 액션 태그를 단일 소스에서 canonical 정의. 프로젝트 이름 현 상태 유지("nexus-code"의 "code"는 Anthropic 트레이드마크 침해 아님).

**Issue #5 — 멀티-하네스 어댑터 전략**: nexus-code 내부에 AgentHost 인터페이스(spawn/observe/approve/reject/dispose) 정의, 그 아래 하네스별 구현체. Claude Code 어댑터는 기존 ProcessSupervisor + stream-json + ApprovalBridge 유지. OpenCode 어댑터는 `opencode serve` HTTP/SSE 또는 `opencode acp` stdio 중 하나를 신규 작성. Agent SDK / ACP 단일 통합 경로는 구독제 호환 불가로 폐기.

---

## §7 외부 포지셔닝 프레임 — "민지의 하루"

**이 §7의 내용은 외부 포지셔닝 전용이다. 내부 아키텍처 문서(.nexus/context/, bridge 문서, 브리핑 세트 등)에는 사용하지 말 것.**

외부(README, landing page, OSS 공개 설명)에서는 3층위 용어를 직접 노출하지 않고 사용 맥락으로 설명한다:

> "Nexus는 에이전트 오케스트레이션 워크플로를 위한 도구 세트다. 민지 같은 indie hacker 개발자가 [plan]으로 의사결정을 구조화하고(claude-nexus 또는 opencode-nexus), 3~6개 세션이 병렬로 실행되는 동안 nexus-code에서 전체 세션을 감독한다."

이 프레임은 "민지(indie hacker, 병렬 세션 작업자)"라는 외부 페르소나를 기준으로 설명 흐름을 구성한다.

**경고**: 이 프레임을 내부 아키텍처 문서에 혼용하면 "완결성 환상"으로 인한 scope creep 위험이 발생한다. 내부 문서에서는 §1의 3층위와 §2의 관계 모델을 사용한다.

---

## §8 이 문서 이후 — 차기 세션 예고

**브리핑 세트 읽기 순서**: 이 primer 이후 해당 프로젝트의 `01-BRIEFING.md` → `02-DECISIONS.md` → `03-IMPLEMENTATION_GUIDE.md` → `04-OPEN_QUESTIONS.md` → `05-REFERENCES.md` 순서로 읽는다. `references/` 서브폴더에는 실험 증거와 외부 인용이 있다.

**연속성**: plan session #1의 결정은 nexus-code의 별도 철학 세션(Plan #5, T3~)에 전제로 이어질 예정이다. 재개 시점은 작성자(사용자) 판단에 따른다.

**재평가 window**: 90-day 재평가 window 이후, 필요 시 레포 구조나 forward-only 정책에 대한 재평가를 수행할 수 있다. 이 문서 자체도 그 시점에 갱신 대상이 될 수 있다.

---

*문서 버전: plan session #1, 2026-04-10. 생태계 구조 변경 시 이 문서를 업데이트하고 4개 레포지토리에 동시 배포할 것.*
