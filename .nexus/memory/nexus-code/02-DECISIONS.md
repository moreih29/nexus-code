# 02-DECISIONS.md — nexus-code 관점 결정 상세

> **세션 메타**: plan session #1, nexus-temp 워크스페이스, 2026-04-10.
> nexus-code는 5개 Issue 중 가장 많은 변화를 받았다. 이 문서는 각 Issue를 nexus-code 구현 관점에서 가장 상세하게 서술한다.

---

## Issue #1 — 통합 멘탈 모델과 Supervision layer 재정의

### 결정 내용

nexus-code는 Authoring / Execution / Supervision 3층위(Primer §1) 중 **Supervision layer**다. 이 위치는 다음 두 가지를 동시에 의미한다:

**(1) Execution layer 세션 프로세스의 외부 감독자**

nexus-code는 Claude Code CLI 프로세스와 OpenCode 프로세스를 외부에서 spawn하고, 해당 프로세스의 상태·메시지 스트림·파일 변경 사항을 읽기 전용으로 관찰한다. 이 측면은 세션 상태에 대한 외부 관찰이다.

**(2) 권한 요청에 대한 Policy Enforcement Point**

Claude Code CLI 에이전트가 도구(파일 수정, 셸 명령 등)를 실행하기 전에 권한을 요청할 때, 이 결정을 내리는 지점이 nexus-code다. Pre-tool-use hook + ApprovalBridge가 이 경로를 구현한다. 외부 감독자가 단순히 보고만 하는 것이 아니라 실제 집행 결정을 내린다.

### flip 모델과의 관계

nexus-code는 Execution layer 내부의 bidirectional flip 모델의 당사자가 아니다(Primer §2.3). nexus-code는 flip 외부에 위치하며, 여러 Execution layer 세션을 동시에 감독할 수 있는 별도 층위다. claude-nexus와 opencode-nexus가 시간에 따라 flip되더라도 nexus-code의 감독 위치는 바뀌지 않는다.

### Plan #5 T5에 대한 영향 — 재명시 필요 플래그

Plan #5 T5는 "Non-goals 원칙"을 다루며, 현재 "Observer 원칙"이라는 문구를 포함한다. 그러나 이번 세션에서 확정된 용어는 **Supervisor**다: 세션 관찰자 + Policy Enforcement Point의 이중 성격을 가진 Supervision layer.

"Observer 원칙"이라는 문구는 nexus-code의 역할 중 (1) 관찰자 측면만을 포착하며, (2) Policy Enforcement Point 측면을 누락하고, 더 중요하게는 (3) 이 프로젝트가 단순 관찰자가 아닌 권한 집행자라는 구조적 사실을 은폐한다.

**Plan #5 T5의 "Observer 원칙" 문구는 차기 세션에서 반드시 재명시되어야 한다.** 재명시 내용은 "Supervision 이중 성격 원칙" — (a) 세션 상태에 대해서는 read-only 관찰, (b) 권한 요청에 대해서는 policy enforcement — 으로 교체되어야 한다. 이 브리핑을 `.nexus/memory/plan-5-philosophy-snapshot.md`에 메모로 기록할 것.

---

## Issue #2 — nexus-core consumer 합류와 정체성 재프레이밍

### nexus-core의 3rd read-only consumer로 합류

nexus-code는 nexus-core의 세 번째 read-only consumer가 된다(claude-nexus, opencode-nexus에 이어). 합류 방식:

- `packages/shared/package.json`의 devDependency에 `@moreih29/nexus-core` 추가
- 빌드 스크립트 `packages/shared/scripts/generate-metadata.mjs` 신규 작성
  - nexus-core의 `agents/*/meta.yml` 파일을 읽어 에이전트 정의를 TypeScript 상수로 변환
  - nexus-core의 `vocabulary/*.yml` 파일을 읽어 capability/category/tag/resume-tier 어휘를 TypeScript 상수 또는 Zod 스키마로 변환
  - 출력: `packages/shared/src/generated/` 디렉토리에 inline

이것은 runtime dependency가 아니라 build-time 소비다. nexus-code는 nexus-core 패키지를 런타임에 불러오지 않는다. 빌드 시점에 metadata를 TypeScript 상수로 가져와 번들에 포함시킨다.

### nexus-core로부터 무엇을 활용하는가

nexus-core metadata를 통해 nexus-code가 강화할 수 있는 기능:

1. **에이전트 카탈로그 UI**: `category` 값을 기반으로 색상 구분, `alias_ko` 필드로 한국어/영어 병기 표시
2. **태그 워크플로우 시각화**: `vocabulary/tags.yml`의 `[plan]` / `[run]` / `[d]` 태그 정의를 기반으로 타임라인 렌더링
3. **capability 기반 권한 시각화**: `no_file_edit`, `no_shell_exec` 등의 capability 추상값과 실제 권한 요청을 매핑하여, 어떤 에이전트가 어떤 종류의 도구를 요청했는지 시각화
4. **이상 감지**: 에이전트의 declared capability와 실제 권한 요청이 불일치할 때 플래그
5. **resume_tier 뱃지**: `persistent` / `bounded` / `ephemeral` 구분을 UI에 뱃지로 표시
6. **멀티-하네스 일관성 보장**: 에이전트 정의가 nexus-core 단일 소스에서 파생되므로, claude-nexus와 opencode-nexus 세션을 동시 감독할 때 에이전트 메타데이터가 일관됨

### 정체성 재프레이밍: "GUI 래퍼"에서 "감독자 워크벤치"로

이전 자기 인식: "코드 에이전트 CLI의 GUI 래퍼 + 추가 기능"

이 표현이 틀린 이유:
- nexus-code는 Claude Code CLI를 "래핑"하지 않는다. 외부에서 spawn하고 감독한다.
- "추가 기능"은 종속 관계를 암시한다. 실제로는 Supervision layer라는 독립적인 역할이다.
- nexus-core 소비, AgentHost 인터페이스, 멀티-하네스 감독은 GUI 래퍼의 역할을 넘는다.

재프레이밍 후: **"Nexus 생태계에 최적화된 에이전트 감독자 워크벤치"**

이 표현이 포착하는 것:
- "Nexus 생태계에 최적화": nexus-core metadata를 소비하여 Nexus 에이전트 시스템에 특화된 시각화와 워크플로우를 제공한다
- "에이전트 감독자": spawn + 관찰 + 권한 중재의 이중 성격
- "워크벤치": 단일 세션이 아니라 여러 세션과 하네스를 동시에 다루는 작업 환경

---

## Issue #3 — 레포 구조 유지와 Forward-only schema 완화

### 4개 독립 레포 유지

nexus-core, claude-nexus, opencode-nexus, nexus-code는 각각 독립 레포로 유지된다. 통합이나 monorepo화 방향은 채택되지 않았다.

nexus-code 입장에서 이것이 의미하는 것:
- nexus-core를 내부 패키지로 갖지 않는다. npm 패키지(`@moreih29/nexus-core`)를 통해 빌드 타임에 소비한다.
- claude-nexus, opencode-nexus의 코드를 직접 의존하지 않는다. AgentHost 인터페이스를 통해 외부 프로세스로 통신한다.

### Forward-only schema 완화

기존의 엄격한 "Phase 1에서는 breaking change 금지" 원칙이 완화된다(Primer §5.1).

nexus-code 적용 방식:
- `packages/shared/src/generated/`의 TypeScript 상수는 nexus-core 업데이트에 따라 변경될 수 있다
- AgentHost 인터페이스 자체는 초기 설계에서 안정성을 목표로 하지만, breaking change가 발생하면 semver major bump + `CHANGELOG.md`의 "Consumer Action Required" 섹션으로 대응한다
- Claude Code adapter와 OpenCode adapter 사이의 인터페이스 계약이 변경될 경우 동일하게 처리한다

---

## Issue #4 — 프로젝트 이름 유지와 vocabulary 단일 소스

### 프로젝트 이름 "nexus-code" 유지

Anthropic 트레이드마크 검토 결과, 핵심 트레이드마크는 "Claude"이지 "code"가 아니다. "nexus-code"는 트레이드마크 침해 위험이 없다. 이름 변경은 없다.

### vocabulary/tags.yml — 태그 시스템 단일 소스

nexus-core에 `vocabulary/tags.yml`이 추가된다. 이 파일은 skill 태그(`[plan]`, `[run]`, `[sync]`)와 inline 액션 태그(`[d]`, `[m]`, `[m:gc]`, `[rule]`, `[rule:*]`)를 canonical하게 정의하는 단일 소스다.

nexus-code 활용: `generate-metadata.mjs`가 이 파일을 읽어 TypeScript 상수로 변환하면, UI의 태그 워크플로우 시각화가 nexus-core canonical 정의를 직접 사용하게 된다. 태그 정의가 변경될 때 nexus-code UI가 자동으로 반영된다.

---

## Issue #5 — 멀티-하네스 어댑터 전략: 옵션 γ 확정

### 옵션 γ 채택 이유

검토된 옵션들:
- **옵션 β**: ACP(Agent Client Protocol) 단일 표준으로 통합 — 폐기. Claude Code의 ACP 어댑터가 Agent SDK 기반으로 재구성됨. 구독제 불가.
- **옵션 δ**: Agent SDK 기반 재설계 — 폐기. API key 전용. 민지 페르소나 PMF 불가(Primer §4.2).
- **옵션 ε**: OpenCode만 지원하는 방향으로 피벗 — 폐기. Claude Code 감독을 포기하는 것은 기존 핵심 자산 및 페르소나 요구사항과 맞지 않음.
- **옵션 γ**: packages/shared에 AgentHost 인터페이스를 정의하고 하네스별 구현체를 두는 방식 — **채택**.

옵션 γ를 선택한 이유:
1. 기존 ProcessSupervisor + stream-json + ApprovalBridge를 그대로 보존하면서 인터페이스 계약 뒤에 위치시킨다. 코드 삭제 없음.
2. 신규 OpenCode adapter를 동일한 인터페이스 계약으로 추가할 수 있다.
3. 구독제 호환성을 전혀 훼손하지 않는다.
4. 미래의 3rd 하네스(가령 다른 코드 에이전트 CLI)를 같은 패턴으로 추가할 수 있다.

### AgentHost 인터페이스 정의

위치: `packages/shared/src/types/agent-host.ts` (초안)

```typescript
// AgentHost — 하네스별 구현체의 공통 계약
// Claude Code adapter와 OpenCode adapter 모두 이 인터페이스를 구현한다

export type AgentHostEvent =
  | { type: 'session_started'; sessionId: string; harnessType: 'claude-code' | 'opencode' }
  | { type: 'message'; sessionId: string; role: 'assistant' | 'user'; content: string }
  | { type: 'tool_call'; sessionId: string; toolName: string; input: unknown }
  | { type: 'permission_asked'; sessionId: string; permissionId: string; toolName: string; input: unknown }
  | { type: 'session_ended'; sessionId: string; exitCode: number | null };

export interface AgentHostConfig {
  harnessType: 'claude-code' | 'opencode';
  workingDirectory: string;
  model?: string;
  // 추가 설정은 하네스별 구현체에서 확장
}

export interface AgentHost {
  /** 새 하네스 세션을 외부 프로세스로 시작한다 */
  spawn(config: AgentHostConfig): Promise<string>; // 반환: sessionId

  /** 세션 이벤트 스트림을 구독한다 (읽기 전용) */
  observe(sessionId: string): AsyncIterable<AgentHostEvent>;

  /** 권한 요청을 승인한다 */
  approve(permissionId: string, decision: { allow: boolean }): Promise<void>;

  /** 권한 요청을 거부한다 */
  reject(permissionId: string, reason: string): Promise<void>;

  /** 세션을 종료하고 리소스를 해제한다 */
  dispose(sessionId: string): Promise<void>;
}
```

### Claude Code adapter — 기존 코드 보존

위치: `packages/server/src/adapters/claude-code-host.ts`

이 파일은 기존 코드를 삭제하지 않는다. 기존 `ProcessSupervisor`, `stream-json` 파싱 로직, `ApprovalBridge`를 그대로 내부에 두고 `AgentHost` 인터페이스를 구현하는 래퍼 클래스로 작성한다.

- `spawn()` → 기존 ProcessSupervisor의 프로세스 시작 로직 호출
- `observe()` → stream-json 파싱으로 생성된 이벤트를 AgentHostEvent로 변환하여 yield
- `approve() / reject()` → ApprovalBridge의 승인/거부 경로 호출
- `dispose()` → 프로세스 종료 로직 호출

기존 코드는 이 래퍼 아래에 그대로 존재한다. 인터페이스만 통일한다.

### OpenCode adapter — 신규 작성

위치: `packages/server/src/adapters/opencode-host.ts`

두 가지 경로 중 하나를 선택해야 한다(실행 단계에서 결정, `04-OPEN_QUESTIONS.md` 참조):

**(경로 A) `opencode serve` + HTTP/SSE 방식**:
- `opencode serve` 명령으로 HTTP 서버 기동
- `GET /event` SSE 엔드포인트를 구독하여 이벤트 수신 → `observe()` 구현
- `POST /permission/:id/reply` 엔드포인트로 승인/거부 → `approve() / reject()` 구현
- E2 실험(`references/experiment-e2-headless-hang.md`)이 이 경로의 SSE permission API 동작을 확인함

**(경로 B) `opencode acp` + stdio JSON-RPC 2.0 방식**:
- `opencode acp` 명령으로 stdio JSON-RPC 서버 기동
- `session/request_permission` 메서드로 권한 요청 처리
- `research-acp-spec.md`가 ACP 오픈 표준 상세 스펙을 정리함

두 경로 모두 OpenCode native 지원 경로다. Agent SDK를 사용하지 않으므로 구독제 호환이다.

### ProcessSupervisor 모델은 필연, 우회로가 아님

이 점을 명확히 한다: 기존 Claude Code CLI spawn + stream-json 파싱 + ApprovalBridge 모델은 "어쩔 수 없이 사용하는 임시 방편"이 아니다.

Primer §4.2가 명시하듯, Anthropic 공식 문서는 제3자 제품이 `claude.ai` 로그인이나 rate limit을 사용하는 것을 허용하지 않는다("Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."). 이는 `@anthropic-ai/claude-agent-sdk`가 구독제 사용자를 지원할 수 없음을 의미한다.

따라서:
- Claude Code CLI를 사용자가 직접 실행하는 구조(ProcessSupervisor)는 구독제를 우회하지 않는다. 사용자가 자신의 Claude 계정으로 CLI를 사용하고, nexus-code는 그 프로세스를 외부에서 감독한다.
- 이것이 구독제 사용자가 Claude Code 세션을 외부 워크벤치로 감독할 수 있는 **유일한 경로**다.
- ProcessSupervisor 모델 제거는 이 유일한 경로를 없애는 것이므로 금지된다.

---

*이 문서는 plan session #1 (2026-04-10) 5개 Issue 결정을 nexus-code 관점에서 상세 서술한다. 실행 단계 미결 결정은 `04-OPEN_QUESTIONS.md` 참조.*
