# 04-OPEN_QUESTIONS.md — nexus-code 미결 질문

> **세션 메타**: plan session #1, nexus-temp 워크스페이스, 2026-04-10.
> 이 문서는 plan session #1에서 결정되지 않은 실행 단계 질문들을 정리한다. `[plan]` 태그가 붙은 항목은 별도 계획 세션에서 다관점 분석이 필요하다.

---

## Q1 — OpenCode adapter 경로 선택 `[plan]`

### 무엇을 결정해야 하는가

`packages/server/src/adapters/opencode-host.ts`를 구현할 때 두 경로 중 하나를 선택해야 한다:

**경로 A**: `opencode serve` + HTTP/SSE 방식
- `opencode serve` 명령으로 로컬 HTTP 서버 기동
- `GET /event` SSE 엔드포인트 구독으로 이벤트 수신 → `observe()` 구현
- `POST /permission/:id/reply` 엔드포인트로 권한 승인/거부 → `approve() / reject()` 구현

**경로 B**: `opencode acp` + stdio JSON-RPC 2.0 방식
- `opencode acp` 명령으로 stdio JSON-RPC 서버 기동
- ACP(Agent Client Protocol) 표준 메서드 사용
- `session/request_permission` 메서드로 권한 요청 처리

### 현재 알려진 것과 부족한 것

| | 경로 A | 경로 B |
|---|---|---|
| OpenCode 지원 확인 | E2 실험(`references/experiment-e2-headless-hang.md`)이 SSE permission API 동작 확인 | `references/research-acp-spec.md`가 ACP 오픈 표준 스펙 정리. E4 실험은 미완료(`references/experiment-e4-acp-mode.md`) |
| Claude Code 통합 가능성 | 불가 (HTTP/SSE 경로는 OpenCode 전용) | 불가 (Claude Code ACP 어댑터는 Agent SDK 기반 — Primer §4.4) |
| 구독제 호환 | 가능 (OpenCode native) | 가능 (OpenCode native) |
| 장점 | HTTP/REST 기반이므로 디버깅 용이, 기존 Hono 서버와 패턴 일치 | 오픈 표준 준수, stdio transport로 네트워크 포트 불필요 |
| 단점 | OpenCode 전용 비표준 API에 의존 | E4 실험 미완료로 실제 동작 미검증 |

### 정보 부족분

- E4 실험(`references/experiment-e4-acp-mode.md`)이 미완료 상태다. ACP stdio 경로의 실제 동작, `session/request_permission` 메서드의 존재 여부, OpenCode acp 명령의 현재 안정성을 검증하지 못했다.
- 경로 A의 `POST /permission/:id/reply` 엔드포인트의 정확한 request/response 스펙이 E2 실험에서 부분적으로만 확인됐다.

### 관련 references

- `references/experiment-e2-headless-hang.md` — 경로 A의 핵심 증거
- `references/experiment-e4-acp-mode.md` — 경로 B 미완료 실험
- `references/research-acp-spec.md` — ACP 표준 상세
- `references/research-opencode-permission.md` — 초기 조사 (일부 번복됨)

---

## Q2 — `generate-metadata.mjs` 상세 스펙 `[plan]`

### 무엇을 결정해야 하는가

`packages/shared/scripts/generate-metadata.mjs`가 nexus-core metadata를 어떤 형태의 TypeScript 산출물로 변환할지 결정해야 한다.

**필드 매핑 질문들**:
- `agents/*/meta.yml`의 어떤 필드를 TypeScript 타입으로 변환하는가? (id, name, description, category, tags, capabilities, resume_tier, model_tier 전부인가, 일부인가)
- `vocabulary/capabilities.yml`, `vocabulary/categories.yml`, `vocabulary/resume-tiers.yml`, `vocabulary/tags.yml` 각각을 어떤 TypeScript 구조로 변환하는가?

**Zod 스키마 자동 생성 여부**:
- TypeScript 타입만 출력할지, Zod 스키마도 자동 생성할지
- Zod 스키마가 있으면 런타임 validation이 가능하지만, 번들 크기와 빌드 복잡도가 증가함

**출력 파일 구조**:
- 단일 파일(`packages/shared/src/generated/index.ts`)로 출력할지
- 용도별 분리(`agents.ts`, `vocabulary.ts`, `tags.ts`)로 출력할지

### 현재 정보 부족분

- nexus-core의 `agents/*/meta.yml` 실제 스키마 구조와 `vocabulary/*.yml` 구조를 확인해야 한다.
- 출력 파일이 nexus-code UI에서 어떤 방식으로 import되는지(정적 import vs 동적 import) 결정이 필요하다.
- 빌드 파이프라인에서 `prebuild` hook으로 실행할지, 별도 `generate` 스크립트로 수동 실행할지.

### 관련 references

- `../00-ECOSYSTEM_PRIMER.md` §1.1 — nexus-core 관리 항목 목록
- `references/bridge-quotes.md` — nexus-core 소비 방식 관련 인용

---

## Q3 — `packages/shared`의 AgentHost 타입 정의 상세 `[plan]`

### 무엇을 결정해야 하는가

`03-IMPLEMENTATION_GUIDE.md`에 제시된 AgentHost 인터페이스는 초안이다. 실제 구현 전에 다음을 결정해야 한다:

**Event 타입 세분화**:
- `tool_call` 이벤트에 tool input의 타입 정의가 필요한가? (`unknown` vs 구체적 타입)
- `permission_asked`와 `tool_call`이 별도 이벤트인가, 아니면 `tool_call`의 하위 상태인가?
- 에러 이벤트 타입이 필요한가? (`error`, `crash`, `timeout`)
- 세션 상태 변화 이벤트가 필요한가? (`session_paused`, `session_resumed`)

**에러 처리 방식**:
- `observe()` AsyncIterable에서 에러가 발생하면 어떻게 전파하는가?
- `spawn()` 실패 시 반환 타입이 `Promise<string>` 인가, `Promise<Result<string, Error>>` 인가?
- Claude Code adapter와 OpenCode adapter가 같은 에러 타입을 throw해야 하는가?

**세션 재개 지원 여부**:
- `spawn()`이 `resumeSessionId` 옵션을 받아야 하는가?
- 세션 재개 시 `observe()`가 과거 이벤트를 replay하는가, 이후 이벤트만 스트리밍하는가?

### 현재 정보 부족분

- Claude Code의 세션 재개 메커니즘(기존 코드베이스에서 어떻게 구현되어 있는지)을 확인해야 한다.
- OpenCode의 세션 재개 지원 여부(경로 A: `/session/:id/resume`, 경로 B: ACP `session/resume`)가 미확인이다.

### 관련 references

- `references/experiment-e1-permission-ask.md` — 기존 permission 흐름
- `references/experiment-e3-subagent-hook.md` — hook 동작 확인

---

## Q4 — nexus-core UI hint 필드 요청 여부 `[plan]`

### 무엇을 결정해야 하는가

nexus-code UI에서 에이전트 카탈로그를 표시할 때 "에이전트 아이콘/색상" 정보가 필요할 수 있다. 이것을 어디서 가져올지 결정해야 한다:

**옵션 A**: nexus-core의 `agents/*/meta.yml`에 `icon`, `color` 같은 UI hint 필드 추가를 `@moreih29/nexus-core`에 요청

장점: 모든 consumer(claude-nexus, opencode-nexus, nexus-code)가 일관된 시각적 정체성을 사용
단점: nexus-core에 UI 관련 필드가 침투함. nexus-core는 "neutral metadata" 원칙을 가짐(Primer §1.1).

**옵션 B**: nexus-code 내부에서 category → 색상/아이콘 매핑 테이블을 별도로 관리

장점: nexus-core neutral metadata 원칙을 지킴. nexus-code가 자체 UI 결정을 소유함
단점: 에이전트가 추가될 때 nexus-code의 매핑 테이블도 별도로 업데이트해야 함

### 현재 정보 부족분

- nexus-core가 "neutral metadata"에 UI hint를 포함시키는 것을 허용하는지 여부가 명시되지 않았다.
- `category` 필드만으로 색상 구분이 충분한지(HOW/DO/CHECK 3개 카테고리) 또는 에이전트별 색상이 필요한지 확인 필요.

### 관련 references

- `../00-ECOSYSTEM_PRIMER.md` §1.1 — nexus-core neutral metadata 원칙
- `references/bridge-quotes.md`

---

## Q5 — Plan #5 T3~ 11개 pending 이슈 재개 시 전제 목록

### 이번 세션이 Plan #5 T3에 미치는 영향

plan session #1 결정들 중 Plan #5 T3 이하 재개 시 전제로 이어지는 항목:

1. **Supervision layer 이중 성격 확정** (Issue #1): T3 이하에서 nexus-code의 역할 경계를 논할 때 이 이중 성격이 고정 전제가 됨
2. **AgentHost 인터페이스 방향 확정** (Issue #5): T3 이하에서 "어떤 하네스를 어떻게 감독할 것인가" 논의는 AgentHost 인터페이스 존재를 전제로 진행됨
3. **nexus-core consumer 합류 확정** (Issue #2): T3 이하에서 에이전트 메타데이터 활용 방식 논의는 nexus-core로부터의 빌드타임 소비를 전제로 진행됨
4. **정체성 재프레이밍 완료** (Issue #2): "감독자 워크벤치" 정체성이 T3 이하 scope/boundary 논의의 출발점이 됨
5. **4개 독립 레포 유지** (Issue #3): T3 이하에서 의존성 구조, 패키지 관계, 배포 방식 논의는 이 구조를 전제로 진행됨

### 정보 부족분

- Plan #5 T3~ T11의 구체적 내용이 이 브리핑 세트에 포함되지 않았다. 재개 전 Plan #5 원본 문서를 확인해야 한다.
- 어떤 T 번호 이슈가 이번 세션 결정과 직접 충돌하거나 전제를 공유하는지 매핑이 필요하다.

---

## Q6 — "Observer 원칙" 재명시 타이밍

### 무엇을 결정해야 하는가

Plan #5 T5의 "Observer 원칙" 문구를 "Supervision 이중 성격 원칙"으로 재명시하는 작업을 언제 진행할지:

**옵션 A**: Plan #5 T5 재개 시 (Plan #5 재개 세션의 첫 번째 작업으로)

장점: Plan #5 전체 맥락 안에서 일관성 있게 처리 가능
단점: Plan #5 재개 시점이 불확실하다. 그 사이 기간 동안 "Observer 원칙" 문구가 혼란을 줄 수 있다.

**옵션 B**: 별도 마이크로 세션에서 즉시 처리

장점: 용어 불일치를 빠르게 해소
단점: Plan #5 전체 맥락 없이 T5 일부만 수정하면 T5 내부 일관성이 흔들릴 수 있다.

### 권장 사항

이것은 작성자 판단 사항이다. 단, `.nexus/memory/plan-5-philosophy-snapshot.md`에 플래그를 남겨두어 Plan #5 재개 시 즉시 인지할 수 있게 하는 것은 두 옵션 모두에서 필요하다.

### 관련 references

- `../00-ECOSYSTEM_PRIMER.md` §3.1 — Supervisor 용어 정의
- `03-IMPLEMENTATION_GUIDE.md` §4 — memory 파일 업데이트 지침

---

## Q7 — claude-nexus와 opencode-nexus 동시 감독 시나리오

### 무엇을 결정해야 하는가

한 nexus-code 인스턴스가 Claude Code 세션과 OpenCode 세션을 동시에 spawn하고 관찰하는 경우를 처음으로 지원하려면 다음을 설계해야 한다:

**sessionId 관리**:
- 두 하네스의 sessionId namespace가 충돌하지 않도록 하는 방식 (`claude-code:${id}` vs `opencode:${id}` prefix)
- SQLite SoT에서 세션 테이블에 `harnessType` 컬럼 추가 필요 여부

**UI 통합 방식**:
- 두 하네스의 세션을 하나의 UI에서 어떻게 구분하여 표시할지
- 사이드바 분리 vs 탭 vs unified timeline

**이벤트 스트림 통합**:
- 두 `AgentHost.observe()` 스트림을 하나의 통합 이벤트 스트림으로 합칠지, 별도 스트림으로 유지할지
- 타임스탬프 기반 정렬이 필요한지

### 현재 정보 부족분

- 이 시나리오는 OpenCode adapter가 완성되기 전까지는 실현 불가능하므로, 현 단계에서 상세 설계는 시기상조다.
- AgentHost 인터페이스 초안(`03-IMPLEMENTATION_GUIDE.md` §5)이 멀티 인스턴스를 지원하는 구조인지 검증 필요.

### 관련 references

- `../00-ECOSYSTEM_PRIMER.md` §2.3 — Supervision이 flip 외부인 이유
- `references/experiment-e2-headless-hang.md` — OpenCode SSE 경로 증거

---

*이 문서는 plan session #1 (2026-04-10) 기준 미결 항목이다. `[plan]` 표시 항목은 별도 계획 세션에서 다관점 분석 후 결정한다.*
