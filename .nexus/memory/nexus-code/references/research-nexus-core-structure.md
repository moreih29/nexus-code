# research-nexus-core-structure.md — nexus-core@0.1.2 실측 조사

> **세션**: Phase 3 착수 전 사전 탐침, nexus-code, 2026-04-12
> **조사 에이전트**: Researcher
> **조사 트리거**: Task 10(packages/shared nexus-core consumer 합류) 착수 전 04-OPEN_QUESTIONS.md Q2 Blocking 항목 해소. 03-IMPLEMENTATION_GUIDE.md §6·§7 가정 검증.
> **교차 참조**: `04-OPEN_QUESTIONS.md` Q2, `03-IMPLEMENTATION_GUIDE.md` §6·§7, `bridge-quotes.md` §2.1

---

## 출처

- 패키지: `@moreih29/nexus-core@0.1.2` (npm public registry)
- 조사 시점: 2026-04-12
- 조사 방법: **방법 B** — `/tmp/nexus-core-probe/`에 tarball(`npm pack`) 다운로드 후 `tar -xzf`로 압축 해제, 파일 직접 열람. npm view --json으로 package.json 메타 확인 병행. 완료 후 임시 디렉토리 삭제.
- Bun workspace 경로: `bun.sh/docs/install/workspaces` 공식 문서 WebFetch로 hoisting 규칙 확인. 실제 install은 Task 10에서 진행(금지 규칙 준수).

증거 분류: **[P]** primary (tarball 직접 확인), **[S]** secondary (공식 문서), **[Inference]** 추론

---

## 이 파일의 목적

Task 10 (packages/shared nexus-core consumer 합류) 착수자가 필드 매핑·파일 경로 질문에 답할 수 있도록 사전 탐침 결과를 기록한다. 03-IMPLEMENTATION_GUIDE.md §6·§7의 가정과 실제 구조 간 차이를 명시한다.

---

## ① agents/\*/meta.yml 실제 필드 (실측)

### 필드 목록 (9개) [P]

`agent.schema.json`의 `required` 배열과 모든 에이전트 meta.yml 실측을 종합:

| 필드 | 타입 | required | 실측값 예시 |
|------|------|----------|------------|
| `id` | string | **required** | `"architect"` |
| `name` | string | **required** | `"architect"` |
| `description` | string | **required** | `"Technical design — evaluates How..."` |
| `category` | string enum | **required** | `"how"` / `"do"` / `"check"` |
| `capabilities` | string[] | **required** | `["no_file_edit", "no_task_create"]` |
| `resume_tier` | string enum | **required** | `"persistent"` / `"bounded"` / `"ephemeral"` |
| `model_tier` | string enum | **required** | `"high"` / `"standard"` |
| `alias_ko` | string | optional | `"아키텍트"` |
| `task` | string | optional | `"Architecture, technical design, code review"` |

**중요**: `body` 필드는 meta.yml에 없다. body는 같은 디렉토리의 `body.md` 파일로 분리되어 있다. `manifest.json`에는 `body_hash`(SHA256)만 포함된다. [P]

### 샘플 파일 전문 — `agents/architect/meta.yml` [P]

```yaml
name: architect
description: Technical design — evaluates How, reviews architecture, advises on
  implementation approach
task: Architecture, technical design, code review
alias_ko: 아키텍트
category: how
resume_tier: persistent
model_tier: high
capabilities:
  - no_file_edit
  - no_task_create
  - no_task_update
id: architect
```

### 전체 에이전트 목록 (9개) [P]

| id | category | resume_tier | model_tier | capabilities |
|----|----------|-------------|------------|--------------|
| architect | how | persistent | high | no_file_edit, no_task_create, no_task_update |
| designer | how | persistent | high | no_file_edit, no_task_create, no_task_update |
| postdoc | how | persistent | high | no_file_edit, no_task_create, no_task_update |
| strategist | how | persistent | high | no_file_edit, no_task_create, no_task_update |
| engineer | do | bounded | standard | no_task_create |
| writer | do | bounded | standard | no_task_create |
| researcher | do | persistent | standard | no_file_edit, no_task_create |
| reviewer | check | ephemeral | standard | no_file_edit, no_task_create |
| tester | check | ephemeral | standard | no_file_edit, no_task_create |

**패턴 발견**: HOW 카테고리 에이전트는 모두 `no_file_edit + no_task_create + no_task_update` (3개). DO/CHECK 에이전트는 최소 `no_task_create` (1~2개).

### 03-IMPLEMENTATION_GUIDE.md bridge-quotes §2.1 가정과의 비교

bridge-quotes §2.1은 neutral layer 필드로 `id, name, alias_ko, description, task, category, tags, capabilities, resume_tier, body, model_tier`를 예상했다. 실측 결과:

- `tags` 필드: meta.yml에 **존재하지 않음**. tags는 `vocabulary/tags.yml`에만 있으며 에이전트별 태그 배열이 아니다. **[P] — 가정 오류, 제거 필요**
- `body` 필드: meta.yml에 **존재하지 않음**. `body.md`라는 별도 파일로 분리. manifest.json에는 `body_hash`만 포함. **[P] — 가정 오류**
- 나머지 7개 필드(`id, name, alias_ko, description, task, category, capabilities, resume_tier, model_tier`): 실측과 일치.

---

## ② vocabulary/\*.yml 파일 목록 + 스키마

### 파일 목록 (4개) [P]

| 파일 | 최상위 키 | 항목 수 | 구조 |
|------|----------|--------|------|
| `vocabulary/capabilities.yml` | `capabilities:` (배열) | 3개 | id, description, harness_mapping |
| `vocabulary/categories.yml` | `categories:` (배열) | 3개 | id, description |
| `vocabulary/resume-tiers.yml` | `resume_tiers:` (배열) | 3개 | id, description |
| `vocabulary/tags.yml` | `tags:` (배열) | 7개 | id, trigger, type, description, [skill/handler], [variants] |

bridge-quotes §3.1에서 예상한 4개 파일 모두 존재. `vocabulary/tags.yml`은 bridge-quotes §3.1 주석("세션 Issue #4에서 추가")대로 실제 배포됨. [P]

### capabilities.yml 스키마 [P]

```yaml
capabilities:
  - id: no_file_edit
    description: "Agent cannot create or modify files in the user's workspace"
    harness_mapping:
      claude_code:
        - Edit
        - Write
        - NotebookEdit
      opencode:
        - edit
        - write
        - patch
        - multiedit
```

3개 capability: `no_file_edit`, `no_task_create`, `no_task_update`. 각 항목은 `id + description + harness_mapping(claude_code[], opencode[])` 구조.

### categories.yml 스키마 [P]

```yaml
categories:
  - id: how
    description: "분석·자문. 깊은 맥락 유지가 핵심 자산. architect, designer, postdoc, strategist."
```

단순 `id + description` 배열. 3개 항목: `how`, `do`, `check`.

### resume-tiers.yml 스키마 [P]

단순 `id + description` 배열. 3개 항목: `persistent`, `bounded`, `ephemeral`.

### tags.yml 스키마 [P]

```yaml
tags:
  - id: plan
    trigger: "[plan]"
    type: skill           # "skill" | "inline_action"
    skill: nx-plan        # type=skill일 때
    description: "Activates nx-plan skill..."
    variants: ["auto"]    # 선택적

  - id: d
    trigger: "[d]"
    type: inline_action
    handler: nx_plan_decide  # type=inline_action일 때
    description: "Records a decision..."
```

7개 항목: plan, run, sync (type=skill), d, m, m-gc, rule (type=inline_action). `variants` 필드는 선택적 (plan, rule만 보유).

---

## ③ package.json exports 실측 [P]

`npm view @moreih29/nexus-core@0.1.2 --json`으로 확인한 실제 exports:

```json
{
  "exports": {
    ".": null,
    "./agents/*": "./agents/*",
    "./skills/*": "./skills/*",
    "./vocabulary/*": "./vocabulary/*",
    "./schema/*": "./schema/*",
    "./manifest.json": "./manifest.json"
  }
}
```

`"." : null` 확인됨. 즉 `import '@moreih29/nexus-core'` 직접 import는 의도적으로 막혀 있다. 파일은 subpath(`./agents/architect/meta.yml` 등) 또는 `fs.readFileSync` 직접 접근으로만 소비 가능하다. [P]

**결론**: `generate-metadata.mjs`는 `import` 방식이 아닌 `fs.readFileSync` + YAML 파싱 방식으로 파일을 읽어야 한다. 이는 03-IMPLEMENTATION_GUIDE.md §7의 스크립트 구조 초안 방향과 일치한다.

---

## ④ Bun workspace 경로 실측 결과 또는 예상

### 실측 불가 이유

Task 10이 공식 첫 install이므로 현재 nexus-code 루트 또는 packages/shared에 `@moreih29/nexus-core`를 install하지 않았다. 실측 대신 Bun 공식 문서와 현재 workspace 구조 기반으로 예상 경로를 도출한다.

### Bun workspace hoisting 규칙 [S]

Bun 공식 문서(bun.sh/docs/install/workspaces) 인용:

> "If `a` and `b` share a common dependency, it will be *hoisted* to the root `node_modules` directory. This reduces redundant disk usage and minimizes 'dependency hell'."

Bun은 npm/yarn과 동일한 **root hoisting** 전략을 사용한다. workspace 패키지(`packages/shared`)의 dependency는 원칙적으로 루트 `node_modules/`로 hoisting된다. 단, 버전 충돌이 있을 때만 workspace 로컬(`packages/shared/node_modules/`)에 설치된다.

### 예상 경로 (install 후 재검증 필요) [Inference: Bun workspace hoisting 규칙 + 현재 구조]

현재 nexus-code 루트 `node_modules/@moreih29/nexus-core`는 존재하지 않는다(다른 패키지가 해당 버전을 요구하지 않음). 따라서 `packages/shared`에 devDependency 추가 후 `bun install` 실행 시:

**예상 경로**: `/Users/kih/workspaces/areas/nexus-code/node_modules/@moreih29/nexus-core`

(루트 node_modules로 hoisting)

### 03-IMPLEMENTATION_GUIDE.md §7의 가정 검증

```javascript
// 03-IMPLEMENTATION_GUIDE.md §7 현재 가정:
const NEXUS_CORE_PATH = resolve(__dirname, '../../../node_modules/@moreih29/nexus-core');
```

`packages/shared/scripts/generate-metadata.mjs`에서 `__dirname`은 `packages/shared/scripts/`이므로:

- `../` → `packages/shared/`
- `../../` → `packages/`
- `../../../` → 프로젝트 루트 (`nexus-code/`)
- `../../../node_modules/@moreih29/nexus-core` → `nexus-code/node_modules/@moreih29/nexus-core`

이 경로는 **root hoisting 가정과 일치**한다. Bun hoisting이 루트에 설치한다는 전제 하에 이 가정은 올바르다. [Inference]

**다만**: Bun이 버전 충돌 등으로 workspace 로컬에 설치할 경우 `packages/shared/node_modules/@moreih29/nexus-core`로 달라진다. Task 10 실행 후 실제 경로를 반드시 확인하고 스크립트 경로를 보정해야 한다.

**보다 안전한 대안**: `require.resolve` 또는 `import.meta.resolve`로 경로를 동적 탐지하는 방식이 hoisting 위치에 무관하게 동작한다:

```javascript
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const NEXUS_CORE_PATH = dirname(require.resolve('@moreih29/nexus-core/manifest.json'));
```

---

## ⑤ generate-metadata.mjs 필드 매핑 초안

### 출력 파일 구조 제안

**권고: 용도별 분리 방식** (`agents.ts`, `vocabulary.ts` 2개 파일)

이유:
- agents와 vocabulary는 소비 패턴이 다르다. UI에서 에이전트 목록만 필요할 때 vocabulary까지 번들링할 필요 없음.
- `manifest.json`이 이미 두 섹션을 구분하고 있어 파일 분리가 자연스럽다.
- 초기 버전에서는 `manifest.json`을 파싱하는 방식이 가장 단순하다 (YAML 파서 불필요).

```
packages/shared/src/generated/
├── agents.ts       — AGENTS 상수 (AgentMetadata[])
└── vocabulary.ts   — CAPABILITIES, CATEGORIES, RESUME_TIERS, TAGS 상수
```

### Zod 스키마 생성 여부

**초기 버전은 Zod 없이 TS 상수만** — 04-OPEN_QUESTIONS Q2 (ii) architect 분류대로.
generate-metadata.mjs 출력은 `as const` TypeScript 상수로 충분하다. Zod는 향후 필요 시 추가.

### TypeScript 타입 예시 코드 (실측 필드 기반)

```typescript
// packages/shared/src/generated/agents.ts
// Auto-generated by scripts/generate-metadata.mjs — DO NOT EDIT

export type AgentCategory = 'how' | 'do' | 'check';
export type AgentResumeTier = 'persistent' | 'bounded' | 'ephemeral';
export type AgentModelTier = 'high' | 'standard';
export type AgentCapability = 'no_file_edit' | 'no_task_create' | 'no_task_update';

export interface AgentMetadata {
  id: string;
  name: string;
  alias_ko?: string;           // optional — meta.yml에서 선택적
  description: string;
  task?: string;               // optional — meta.yml에서 선택적
  category: AgentCategory;
  capabilities: AgentCapability[];
  resume_tier: AgentResumeTier;
  model_tier: AgentModelTier;
}

export const AGENTS: readonly AgentMetadata[] = [
  {
    id: 'architect',
    name: 'architect',
    alias_ko: '아키텍트',
    description: 'Technical design — evaluates How, reviews architecture, advises on implementation approach',
    task: 'Architecture, technical design, code review',
    category: 'how',
    capabilities: ['no_file_edit', 'no_task_create', 'no_task_update'],
    resume_tier: 'persistent',
    model_tier: 'high',
  },
  // ... 나머지 8개 에이전트
] as const;
```

```typescript
// packages/shared/src/generated/vocabulary.ts
// Auto-generated by scripts/generate-metadata.mjs — DO NOT EDIT

export interface CapabilityMetadata {
  id: string;
  description: string;
  harness_mapping: {
    claude_code: string[];
    opencode: string[];
  };
}

export const CAPABILITIES: readonly CapabilityMetadata[] = [
  {
    id: 'no_file_edit',
    description: "Agent cannot create or modify files in the user's workspace",
    harness_mapping: {
      claude_code: ['Edit', 'Write', 'NotebookEdit'],
      opencode: ['edit', 'write', 'patch', 'multiedit'],
    },
  },
  // ... no_task_create, no_task_update
] as const;
```

### generate-metadata.mjs 구현 전략

`"." : null` 제약으로 인해 `import` 방식 불가. `manifest.json`을 직접 읽는 방식이 YAML 파서 없이 가장 단순하다:

```javascript
#!/usr/bin/env node
// packages/shared/scripts/generate-metadata.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// manifest.json을 통해 경로 탐지 (hoisting 위치 무관)
const manifestPath = require.resolve('@moreih29/nexus-core/manifest.json');
const NEXUS_CORE_PATH = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const OUTPUT_DIR = resolve(__dirname, '../src/generated');
mkdirSync(OUTPUT_DIR, { recursive: true });

// manifest.json의 agents 배열을 직접 소비
// → YAML 파서 불필요, 단일 파싱 경로
const agents = manifest.agents; // body_hash는 제외하고 나머지 필드만 사용
```

---

## Task 10 착수자에게의 교훈

- **`tags` 필드는 meta.yml에 없다**: bridge-quotes §2.1의 neutral layer 필드 예상 목록에 `tags`가 포함되어 있으나, 실제 meta.yml에는 없다. `vocabulary/tags.yml`은 에이전트별 태그가 아닌 Nexus 시스템 태그(`[plan]`, `[run]` 등) 정의다. `AgentMetadata` 타입에 `tags` 필드를 추가하지 말 것.

- **`body` 필드도 meta.yml에 없다**: generate-metadata.mjs가 에이전트 prompt body를 포함해야 한다면 `agents/{id}/body.md`를 별도로 `readFileSync`해야 한다. 초기 버전(UI 카탈로그 표시 목적)은 body 제외 권고 — `manifest.json`만으로 충분하다.

- **`manifest.json` 활용 권고**: agents·skills·vocabulary 세 섹션이 단일 JSON으로 pre-flattened되어 있다. YAML 파서(`yaml` 패키지) 없이 `manifest.json`만 파싱하면 generate-metadata.mjs 의존성을 0으로 유지할 수 있다. 단, `body_hash` 필드는 generate-metadata 목적에 불필요하므로 출력 시 제외한다.

- **Bun 경로는 root hoisting 예상이나 실측 필요**: 03-IMPLEMENTATION_GUIDE.md §7의 `resolve(__dirname, '../../../node_modules/@moreih29/nexus-core')` 경로는 root hoisting 가정으로 이론상 올바르다. 그러나 Task 10에서 `bun install` 후 실제 설치 위치를 `ls node_modules/@moreih29` 및 `ls packages/shared/node_modules/@moreih29`로 반드시 확인하고 스크립트 경로를 보정할 것. 안전한 대안: `require.resolve('@moreih29/nexus-core/manifest.json')`로 동적 탐지.

- **subpath exports `"." : null` 제약**: `import '@moreih29/nexus-core'` 직접 import는 의도적으로 차단됨. generate-metadata.mjs는 반드시 `fs.readFileSync` 방식(또는 subpath: `'@moreih29/nexus-core/manifest.json'`)으로 파일을 읽어야 한다. 이것은 제약이 아니라 설계 의도다 — 런타임 번들에 nexus-core가 포함되지 않도록 막는 가드.

---

*이 파일: Phase 3 착수 전 탐침, 2026-04-12. Task 10 완료 후 Bun 경로 실측 결과를 §③에 보완할 것.*
