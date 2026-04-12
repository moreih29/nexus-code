# 03-IMPLEMENTATION_GUIDE.md — nexus-code 구현 가이드

> **세션 메타**: plan session #1, nexus-temp 워크스페이스, 2026-04-10.
> 이 문서는 plan session #1 결정을 nexus-code 코드베이스에 반영하기 위해 수정·신규 작성해야 할 파일 목록과 지침을 제공한다. 각 파일의 정확한 경로와 변경 내용을 기술한다.

---

## 수정 대상 파일

### 1. `.nexus/context/architecture.md`

**변경 유형**: 섹션 추가

**추가할 내용**: "Nexus ecosystem 3-layer 프레임" 섹션

이 섹션은 Authoring / Execution / Supervision 3층위를 내부 아키텍처 문서 맥락에서 정의하고, nexus-code의 위치를 Supervision layer로 명시한다. 다음 내용을 포함해야 한다:

- **Authoring layer**: nexus-core. 프롬프트, neutral metadata, vocabulary를 정의하는 canonical source. 집행 semantics 없음.
- **Execution layer**: claude-nexus, opencode-nexus. 에이전트 조립·디스패치·권한 집행·태스크 파이프라인 소유. 둘은 sibling이며 bidirectional flip 대상.
- **Supervision layer**: nexus-code. Execution layer 세션을 외부에서 spawn·관찰·권한 중재·시각화. flip 외부.

주의 사항: 이 3층위 프레임은 내부 아키텍처 문서 전용이다. 외부 포지셔닝 문서(README, landing page)에는 사용하지 않는다(Primer §1.4, §7).

---

### 2. `.nexus/context/permission-architecture.md`

**변경 유형**: 기존 문구 재명시

**변경 전**: "Observer 원칙" 관련 문구 (기존 문서에서 nexus-code를 단순 관찰자로 기술하는 부분)

**변경 후**: "Supervision 이중 성격" 섹션으로 교체

교체 내용의 핵심 두 요소:

**(a) 세션 관찰자 측면**: 세션 상태, 메시지 스트림, 파일 변경 사항을 읽기 전용으로 관찰한다. 이 측면은 변경 없이 유지된다.

**(b) Policy Enforcement Point 측면**: 에이전트의 권한 요청(파일 수정, 셸 명령 등)에 대해 승인 또는 거부 결정을 내리는 집행 지점이다. Pre-tool-use hook이 요청을 가로채고, ApprovalBridge가 nexus-code UI와의 통신 경로를 제공하며, 사용자의 결정이 Claude Code CLI 프로세스로 전달된다.

이중 성격의 구조적 기원: Claude Code CLI는 권한 요청→승인→실행 흐름을 대화형으로 이을 수 없는 비대화형 구조다. 이 구조적 한계가 외부 감독자가 Policy Enforcement Point를 담당하는 필연성을 만든다.

---

### 3. `.nexus/context/session-flow.md`

**변경 유형**: AgentHost 인터페이스 언급 추가

**추가할 내용**:

- AgentHost 인터페이스가 하네스별 구현체의 공통 계약임을 명시
- ProcessSupervisor가 AgentHost 인터페이스의 Claude Code 구현체(adapter)임을 명시
- 세션 흐름 다이어그램 또는 설명에서 AgentHost 계층이 중간에 위치함을 반영

세션 흐름의 수정된 구조:

```
nexus-code UI
  └─> AgentHost 인터페이스
        ├─> Claude Code adapter (ProcessSupervisor + stream-json + ApprovalBridge)
        │     └─> Claude Code CLI 프로세스
        └─> OpenCode adapter (신규)
              └─> OpenCode 프로세스
```

---

### 4. `.nexus/memory/plan-5-philosophy-snapshot.md`

**변경 유형**: 섹션 추가

**추가할 섹션**: "plan session #1 (2026-04-10) 결과 — Plan #5 T3 재개 전제"

이 섹션이 기록해야 할 내용:

1. **T3 재개 전제 목록**: plan session #1에서 확정된 결정 중 Plan #5 T3 이하 재개 시 전제로 이어지는 항목들
   - Supervision layer 이중 성격 (세션 관찰자 + Policy Enforcement Point)
   - AgentHost 인터페이스 (spawn/observe/approve/reject/dispose)
   - nexus-core read-only consumer 합류 방식
   - 정체성 재프레이밍 ("감독자 워크벤치")
   - 4개 독립 레포 유지

2. **T5 재명시 필요 플래그**: Plan #5 T5의 "Observer 원칙" 문구가 Supervision 이중 성격 프레임과 충돌함. 차기 Plan #5 세션에서 "Supervision 이중 성격 원칙"으로 재명시 필요.

---

## 신규 작성 파일

### 5. `packages/shared/src/types/agent-host.ts`

**변경 유형**: 신규 (TypeScript 인터페이스 초안)

**내용**: `02-DECISIONS.md` Issue #5 섹션의 AgentHost 인터페이스 초안을 그대로 사용.

전체 내용:

```typescript
// AgentHost — 하네스별 구현체의 공통 계약
// 이 인터페이스를 구현하는 어댑터:
//   - packages/server/src/adapters/claude-code-host.ts (기존 ProcessSupervisor 래핑)
//   - packages/server/src/adapters/opencode-host.ts (신규)

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

**주의**: 이것은 초안이다. Event 타입 세분화, 에러 처리 방식, 세션 재개 지원 여부는 `04-OPEN_QUESTIONS.md`의 미결 질문으로 이어진다.

---

### 6. `packages/shared/package.json`

**변경 유형**: devDependency 추가

**추가 내용**:

```json
{
  "devDependencies": {
    "@moreih29/nexus-core": "latest"
  }
}
```

**적용 시점**: Phase 1b 또는 Phase 2 초입. `generate-metadata.mjs` 스크립트 작성과 함께 진행한다.

**주의**: `dependencies`가 아닌 `devDependencies`에 추가한다. nexus-core는 빌드 타임에만 소비되며, 런타임 번들에 포함되지 않는다.

---

### 7. `packages/shared/scripts/generate-metadata.mjs`

**변경 유형**: 신규 스크립트

**목적**: nexus-core의 metadata를 읽어 TypeScript 상수 파일을 생성한다. 빌드 파이프라인에서 실행되며, 출력은 `packages/shared/src/generated/`에 저장된다.

**스크립트 구조 초안**:

```javascript
#!/usr/bin/env node
// packages/shared/scripts/generate-metadata.mjs
// nexus-core metadata → TypeScript 상수 생성기
// 실행: node packages/shared/scripts/generate-metadata.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEXUS_CORE_PATH = resolve(__dirname, '../../../node_modules/@moreih29/nexus-core');
const OUTPUT_DIR = resolve(__dirname, '../src/generated');

// 출력 디렉토리 보장
mkdirSync(OUTPUT_DIR, { recursive: true });

// agents/*/meta.yml 수집 및 변환 (상세 스펙은 04-OPEN_QUESTIONS.md 참조)
// vocabulary/*.yml 수집 및 변환

// 출력 파일 예시:
// - packages/shared/src/generated/agents.ts
// - packages/shared/src/generated/vocabulary.ts
```

**미결 사항**: 어떤 필드를 어떤 TypeScript 타입으로 변환할지, Zod 스키마 자동 생성 여부, output 파일 구조 상세는 `04-OPEN_QUESTIONS.md` 참조.

**`packages/shared/package.json` scripts에 추가**:

```json
{
  "scripts": {
    "generate": "node scripts/generate-metadata.mjs",
    "prebuild": "node scripts/generate-metadata.mjs"
  }
}
```

---

### 8. `packages/shared/src/generated/` 디렉토리

**변경 유형**: 신규 디렉토리 + `.gitignore` 결정 필요

이 디렉토리는 `generate-metadata.mjs`의 출력 파일이 위치하는 곳이다.

**`.gitignore` 처리 두 가지 옵션**:
- **옵션 A**: gitignore에 추가 (빌드 시 생성, CI/CD에서 재생성). nexus-core가 자주 변경되는 경우 적합.
- **옵션 B**: 커밋 포함 (생성 파일을 소스로 관리). 빌드 없이도 타입 정보 사용 가능, 리뷰 가능.

현재 1인 dogfooding 맥락에서는 옵션 A가 단순하다. 결정은 실행 단계에서 진행한다.

---

### 9. `packages/server/src/adapters/claude-code-host.ts`

**변경 유형**: 신규 (기존 코드 래핑)

**목적**: 기존 ProcessSupervisor + stream-json + ApprovalBridge를 AgentHost 인터페이스 구현체로 래핑한다. **기존 코드를 삭제하지 않는다.**

**구조**:

```typescript
// packages/server/src/adapters/claude-code-host.ts
import type { AgentHost, AgentHostConfig, AgentHostEvent } from '@nexus-code/shared/types/agent-host';

// 기존 ProcessSupervisor, ApprovalBridge를 import
// (경로는 기존 코드베이스 구조에 따라)

export class ClaudeCodeHost implements AgentHost {
  async spawn(config: AgentHostConfig): Promise<string> {
    // 기존 ProcessSupervisor 프로세스 시작 로직을 호출
    // sessionId 반환
  }

  observe(sessionId: string): AsyncIterable<AgentHostEvent> {
    // 기존 stream-json 파싱 이벤트를 AgentHostEvent 타입으로 변환하여 yield
  }

  async approve(permissionId: string, decision: { allow: boolean }): Promise<void> {
    // 기존 ApprovalBridge의 승인 경로 호출
  }

  async reject(permissionId: string, reason: string): Promise<void> {
    // 기존 ApprovalBridge의 거부 경로 호출
  }

  async dispose(sessionId: string): Promise<void> {
    // 프로세스 종료 로직 호출
  }
}
```

이 파일을 작성할 때 기존 ProcessSupervisor, ApprovalBridge 코드를 이동하거나 삭제하지 않는다. 래퍼 레이어만 추가한다.

---

### 10. `packages/server/src/adapters/opencode-host.ts`

**변경 유형**: 신규 (OpenCode adapter)

**목적**: OpenCode 프로세스를 AgentHost 인터페이스로 감독하는 어댑터.

**경로 선택은 `04-OPEN_QUESTIONS.md`에서 [plan] 필요**. 두 경로의 초안:

**경로 A (`opencode serve` + HTTP/SSE) 초안**:

```typescript
// packages/server/src/adapters/opencode-host.ts
import type { AgentHost, AgentHostConfig, AgentHostEvent } from '@nexus-code/shared/types/agent-host';

export class OpenCodeHost implements AgentHost {
  async spawn(config: AgentHostConfig): Promise<string> {
    // opencode serve 실행
    // 반환된 포트에서 SSE 연결 준비
  }

  observe(sessionId: string): AsyncIterable<AgentHostEvent> {
    // GET /event SSE 구독
    // SSE 이벤트를 AgentHostEvent로 변환하여 yield
  }

  async approve(permissionId: string, decision: { allow: boolean }): Promise<void> {
    // POST /permission/:id/reply 호출
  }

  async reject(permissionId: string, reason: string): Promise<void> {
    // POST /permission/:id/reply 호출 (거부)
  }

  async dispose(sessionId: string): Promise<void> {
    // opencode 프로세스 종료
  }
}
```

**경로 B (`opencode acp` + stdio JSON-RPC) 초안**: 구조는 동일하나 stdio transport 사용.

---

## 거절 목록 — 하지 말 것

1. **`@anthropic-ai/claude-agent-sdk` 기반 재설계 금지**

   이유: Anthropic 공식 문서가 제3자 제품에서 `claude.ai` 로그인 또는 rate limit 사용을 명시적으로 금지한다("Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."). `@anthropic-ai/claude-agent-sdk`는 API key 전용이며, 민지 페르소나(Claude Pro/Max 구독제 사용자) PMF가 불가능하다. 근거: `references/agent-sdk-constraint.md`, Primer §4.2.

2. **ACP 단일 표준으로 두 하네스 통합 감독 시도 금지**

   이유: Claude Code의 ACP 어댑터는 Agent SDK 기반으로 재구성되어 있다. 구독제 사용자가 Claude Code 세션을 ACP로 감독하는 경로는 현재 불가능하다(Primer §4.4). `references/research-claude-code-acp.md` 참조.

3. **ProcessSupervisor + stream-json 모델 제거 또는 교체 금지**

   이유: 이것은 구독제 사용자가 Claude Code 세션을 외부에서 감독할 수 있는 유일한 경로다. 우회로나 임시 방편이 아니라 구조적 필연이다(Primer §4.3). 이 모델을 AgentHost 인터페이스 뒤에 래핑하는 것은 허용되지만, 제거는 금지다.

4. **"Observer" 용어를 새 설계 문서에서 사용 금지**

   이유: nexus-code의 역할은 단순 관찰자가 아닌 Policy Enforcement Point를 포함하는 Supervisor다(Primer §3.1). "Observer" 용어는 이 이중 성격을 오해하게 만든다. 역사적 맥락(기존 문서에서 "Observer 원칙"을 수정하는 맥락)에서만 언급 허용.

5. **nexus-core에 runtime 코드 기여 금지**

   이유: nexus-code는 nexus-core의 read-only consumer다. `@moreih29/nexus-core` 패키지에 코드를 기여하거나 fork하여 runtime 로직을 추가하는 것은 3층위 경계 원칙(Primer §1.1, bridge §9.2 runtime 공유 배제)을 위반한다. 빌드 타임 metadata 소비만 허용.

6. **에이전트 카탈로그 편집 UI 추가 금지**

   이유: Plugin boundary 원칙(Plan #5 T5). nexus-core 기반 에이전트 카탈로그는 "표시"만 허용된다. 에이전트 정의를 nexus-code UI에서 편집하는 기능은 Authoring layer(nexus-core)의 역할을 침범한다. 카탈로그는 nexus-core의 metadata를 시각화하는 데 그쳐야 한다.

7. **Claude Code CLI 권한 모델 우회 시도 금지**

   이유: ApprovalBridge가 Pre-tool-use hook으로 권한 요청을 가로채는 것이 구조적 필연이다. Claude Code CLI는 비대화형이므로 다른 방법으로는 외부 감독자가 권한 결정에 개입할 수 없다. Hook을 우회하거나 CLI를 수정하려는 접근은 이 필연성을 파괴한다.

---

## 실행 단계 미결 결정 — `04-OPEN_QUESTIONS.md`로 이어지는 항목

1. **OpenCode adapter 경로 선택**: HTTP/SSE(`opencode serve`) vs stdio JSON-RPC(`opencode acp`) — `04-OPEN_QUESTIONS.md` 참조
2. **`generate-metadata.mjs` 상세 스펙**: 출력 타입, Zod 스키마 여부, 파일 구조 — `04-OPEN_QUESTIONS.md` 참조
3. **AgentHost 타입 정의 상세**: Event 타입 세분화, 에러 처리, 세션 재개 — `04-OPEN_QUESTIONS.md` 참조
4. **`generated/` 디렉토리 `.gitignore` 처리**: commit vs ignore — 실행 단계 판단

---

*이 문서는 plan session #1 (2026-04-10) 기준 구현 지침이다. 각 미결 항목은 `04-OPEN_QUESTIONS.md`에서 `[plan]` 세션으로 처리한다.*
