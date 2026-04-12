# bridge-quotes.md — nexus-core-bootstrap.md 핵심 인용 보존

## 출처

`opencode-nexus/docs/bridge/nexus-core-bootstrap.md`
작성 시점: plan session #16 in opencode-nexus, 2026-04-10

## 이 파일의 목적

bridge 98KB 원본 계획 문서의 핵심 섹션을 인용 형태로 보존한다. 이 distribution 문서 세트(nexus-temp plan session #1)가 bridge의 canonical 결정을 재발명하지 않도록, 결정의 근거를 원문 인용으로 링크한다. 원본 문서는 opencode-nexus 레포 안에 존재하며 그 위치가 canonical이다.

교차 참조: [agent-sdk-constraint.md](./agent-sdk-constraint.md)

---

## §0 대상 독자 — bridge 문서의 자체 정의

원문 인용:

> **Target reader / 대상 독자:** A future LLM instance that has no access to the original conversation, no memory of the plan session, and no context about the decision rationale. This LLM will read this document and execute Phase 1 bootstrapping of `nexus-core` in a fresh, empty repository. Every piece of information needed for that execution is included inline — nothing is omitted on the assumption that context exists elsewhere.

세션(plan #1)에서의 해석: 이 bootstrap 문서는 "원본 대화 없이 Phase 1을 실행할 수 있어야 한다"는 목표 아래 작성되었다. 이번 세션의 distribution 문서 세트도 동일한 원칙을 따른다 — 이 파일들을 읽은 LLM이 이전 대화 없이 생태계 결정을 재현할 수 있어야 한다.

---

## §1.4 Bidirectional framing — 양방향 프레이밍

원문 인용:

> Corrected framing (adopted): The author is a "Nexus user on harness X this month". This month it may be Claude Code, next season it may be OpenCode. Neither project is permanently canonical. At any given time, the active harness accumulates prompt improvements, and those improvements need to flow into the shared library and thence to the inactive harness.

세션(plan #1)에서의 해석:
- Execution layer(claude-nexus ↔ opencode-nexus)의 2-way sibling 관계의 원천 근거.
- "Neither project is permanently canonical" 문구가 어느 한쪽을 parent로 고정하는 모든 옵션(Strict Mirror, Soft Fork)을 기각하는 논리적 기반이다.
- Supervision(nexus-code)은 이 flip의 당사자가 아님 — §2.3 "Supervision은 flip 외부" 결정의 토대.

---

## §1.5 Option E 선택 근거 — 5개 옵션 비교표

원문 인용 (표 전문):

> | Option | Name | Description | Verdict |
> |--------|------|-------------|---------|
> | A | Strict Mirror | opencode-nexus is a byte-for-byte mirror of claude-nexus with automated sync | **Rejected** — Fails at primitive level. Claude Code primitives `PreCompact` and `SubagentStart` do not exist in OpenCode. The hook system, MCP bridge pattern, and tool name space are fundamentally different. Mirroring produces broken content. |
> | B | Soft Fork | opencode-nexus is a fork of claude-nexus; periodically cherry-pick changes | **Rejected under bidirectional reframe** — Soft Fork's "cherry-pick every 2 weeks" obligation assumes stable direction. When the flip occurs (opencode-nexus becomes primary), there is no merge base, no rename tiebreaker, and the flow reversal breaks the model. |
> | C | Reimplementation | Write all prompts independently from scratch for opencode-nexus | **Rejected** — The premise is empirically false. The agent prompt bodies in `src/agents/prompts.ts` are already nearly verbatim copies of the claude-nexus agent markdown bodies. 25 versions of prompt iteration already exist in claude-nexus. Reimplementation discards that work and multiplies effort under bidirectional scenario. |
> | D | Full Shared-Core with runtime | Extract both prompt content AND runtime code (hooks, MCP, tool implementations) into a shared package | **Rejected as temporally wrong** — This is the correct long-term destination but incorrect now. claude-nexus is too volatile to freeze for extraction. The runtime abstraction layer (abstracting over Claude Code hooks vs OpenCode hooks) is speculative engineering before both harnesses have stabilized. |
> | E | Shared Prompt Library | Extract only prompt bodies and metadata (no runtime code) into `@moreih29/nexus-core`; each harness resolves capabilities against its own tool namespace | **Adopted** — Minimum viable abstraction. Prompts are platform-neutral. Runtime code stays per-harness. Capability abstraction layer resolves tool-name differences cleanly without speculative runtime engineering. |

세션(plan #1)에서의 해석: Option E 채택. nexus-core는 prompt + neutral metadata + vocabulary만 담는다. 이 결정이 세션 Issue #1의 Authoring layer 정의와 Issue #2의 nexus-core 범위 재확인의 원천이다.

---

## §2.1 Two-layer split: neutral vs runtime-specific

원문 인용:

> **Neutral layer (shared in nexus-core):**
>
> These fields are platform-independent and can be consumed by any harness without modification:
>
> - `id` — unique string identifier for the agent (e.g., `architect`)
> - `name` — display name (e.g., `Architect`)
> - `alias_ko` — Korean name (e.g., `아키텍트`)
> - `description` — one-line description of the agent's role
> - `task` — short description of the tasks this agent handles
> - `category` — one of `how`, `do`, `check`
> - `tags` — list of descriptive strings
> - `capabilities` — list of abstract capability constraint strings (e.g., `["no_file_edit", "no_task_create"]`)
> - `resume_tier` — one of `ephemeral`, `bounded`, `persistent`
> - `body` — the full markdown prompt body, after stripping any host-specific tool name references
> - `model_tier` — abstract model tier (e.g., `high`, `standard`) — **not** a concrete model identifier
>
> **Forbidden in neutral layer (must NOT appear in nexus-core):**
>
> - Concrete model names (e.g., `opus`, `sonnet`, `openai/gpt-5.3-codex`)
> - Raw `disallowedTools` lists containing harness-specific tool identifiers (e.g., `mcp__plugin_claude-nexus_nx__nx_task_add`, `edit`, `write`)
> - Runtime-enforced `maxTurns` integers (this is a harness-local policy)
> - MCP tool call references in body text (e.g., `mcp__plugin_claude-nexus_nx__X` → must be rewritten to abstract `nx_X` during extraction)

세션(plan #1)에서의 해석: 세션 §1 Primer의 Authoring layer 정의("nexus-core는 프롬프트, neutral metadata, vocabulary를 정의하는 공유 자산이다. 집행 semantics를 포함하지 않는다")의 직접적 기반. concrete model name 금지와 maxTurns 금지가 명시적으로 나열되어 있어 차후 논쟁 방지.

---

## §2.2 Capability abstraction pattern

원문 인용 (매핑 표):

> | Abstract capability | Concern | Claude Code mapping | OpenCode mapping |
> |--------------------|---------|---------------------|------------------|
> | `no_file_edit` | Prevent writing or editing files | `Edit`, `Write`, `NotebookEdit` | `edit`, `write`, `patch`, `multiedit` |
> | `no_task_create` | Prevent creating new tasks | `mcp__plugin_claude-nexus_nx__nx_task_add` | `nx_task_add` |
> | `no_task_update` | Prevent updating existing tasks | `mcp__plugin_claude-nexus_nx__nx_task_update` | `nx_task_update` |
> | `no_shell_exec` | Prevent executing shell commands | `Bash` | `bash` |

원문 설명 인용:

> Why this resolves the leaky abstraction: if nexus-core stored Claude Code's `mcp__plugin_claude-nexus_nx__nx_task_add` directly, OpenCode would have no use for it (the tool doesn't exist in OpenCode's tool space). Conversely, if it stored OpenCode's `nx_task_add`, Claude Code couldn't use it. The abstraction layer means nexus-core stores neither — it stores `no_task_create`, and each harness's build process resolves that to its own concrete identifier.

세션(plan #1)에서의 해석: 세션 §3.4 capability abstraction 용어 고정의 기반. "추상 capability 문자열을 각 하네스가 자기 tool namespace로 resolve한다"는 Primer 문구가 이 §2.2에서 유래한다.

---

## §2.3 Forward-only schema

원문 인용:

> The nexus-core schema follows a forward-only evolution policy during Phase 1:
>
> - No breaking changes to the meta.yml field schema during Phase 1
> - Additive changes (new optional fields) are allowed with a minor version bump
> - Breaking changes (removing required fields, changing field semantics) require a major version bump and are deferred until claude-nexus adopts the package
> - Both semver minor and patch bumps are non-breaking
>
> This policy exists because claude-nexus will eventually adopt nexus-core in Phase 2. If the schema breaks during Phase 1 (before claude-nexus consumes it), Phase 2 integration faces an avoidable migration burden.

**완화 표시**: 이 섹션의 원칙은 Phase 1 엄격 금지로 규정되었으나, 이번 세션(plan #1)에서 완화되었다(Primer §5.1). 1인 dogfooding 맥락에서 "완벽한 사전 방어보다 실제 문제를 경험하며 대응 전략을 학습하는 것이 가치 있다"는 판단. Breaking change 발생 시 대응 방식: semver major bump + CHANGELOG.md에 "Consumer Action Required" 섹션 추가.

세션(plan #1)에서의 해석: Issue #3 레포 구조 결정에서 forward-only 완화가 명시적으로 확정되었다.

---

## §2.4 Staged migration

원문 인용:

> Phase 1 (opencode-nexus first): Only opencode-nexus integrates nexus-core. claude-nexus is untouched. The sync script runs manually: when the author makes a prompt change in claude-nexus, they run `import-from-claude-nexus.mjs` to pull the change into nexus-core. opencode-nexus's `generate-prompts.mjs` then regenerates the TypeScript source.
>
> Phase 2 (both harnesses consume): Triggered by measurable flip signals (see §11). claude-nexus implements its own loader to read from the package. At this point, both harnesses are consuming nexus-core, and the sync script becomes bidirectional (or is retired in favor of direct nexus-core editing).
>
> Why staging avoids the lockstep-refactor objection: the objection "both repos need to change simultaneously" is false under staging. opencode-nexus changes first; claude-nexus changes independently later when the flip conditions are met. There is no moment where both repos must be refactored together.

세션(plan #1)에서의 해석: Issue #3의 "4개 독립 레포 유지" 결정의 기반. "lockstep-refactor 없음"이 4개 분리 레포를 정당화하는 핵심 논리.

---

## §3.1 Directory tree

원문 인용:

```
nexus-core/
  agents/
    architect/
      body.md
      meta.yml
    ...
  skills/
    nx-init/
      body.md
      meta.yml
    ...
  vocabulary/
    capabilities.yml
    categories.yml
    resume-tiers.yml
  schema/
    agent.schema.json
    skill.schema.json
    capability.schema.json
  scripts/
    import-from-claude-nexus.mjs
  .import-state.json          (generated, gitignored)
  .github/
    workflows/
      validate.yml
  package.json
  VERSION
  CHANGELOG.md
  README.md
  LICENSE
```

세션(plan #1) 확장 표시: 세션 Issue #4에서 `vocabulary/tags.yml`이 추가되었다. bridge 원본의 이 트리에는 없으나, Primer §1.1에서 canonical 추가로 확정됨. `vocabulary/tags.yml`은 skill 태그([plan], [run], [sync])와 inline 액션 태그([d], [m], [m:gc], [rule], [rule:*])를 단일 소스에서 정의한다.

---

## §7 CI gates

원문 인용 — capability-integrity 핵심 로직:

> The capability-integrity job verifies two things:
> 1. Every capability string referenced in any meta.yml's `capabilities` list exists in `vocabulary/capabilities.yml`
> 2. Every such capability has a non-empty mapping for BOTH `claude-code` AND `opencode`
>
> If a capability is referenced but only has a mapping for one runtime, the job fails. This prevents "half-mapped" capabilities from being published.

5개 CI gate 목록 (원문 workflow jobs에서 발췌):
- `schema-validate` — AJV로 meta.yml → schema/*.json 검증
- `capability-integrity` — 위 인용: unmapped capability를 fail 처리
- `body-lint` — body.md에서 host-specific 패턴(`mcp__plugin_`, `$CLAUDE_PLUGIN_ROOT`, `NotebookEdit`, `AskUserQuestion`) 탐지
- `import-roundtrip` — Phase 1에서는 SKIP, Phase 1+ 이후 활성화
- `release-tag` — VERSION 변경 시 tag 생성, npm publish는 수동

세션(plan #1)에서의 해석: capability-integrity가 nexus-core 자체 CI에서 unmapped capability를 fail시키는 안전 장치임을 재확인. 이 게이트가 없으면 "half-mapped" capability가 배포되어 한쪽 하네스에서만 동작하는 버그 발생.

---

## §8.3 devDependency vs dependency

원문 인용 (전문):

> `@moreih29/nexus-core` is a **devDependency** in opencode-nexus. Rationale: the package contains only static data (markdown and YAML files). The `generate-prompts.mjs` script reads those files at build time and inlines the content as TypeScript string literals in `prompts.generated.ts`. The published `dist/index.js` bundle contains no runtime I/O calls to the package — the data is baked in. Therefore, end users of `opencode-nexus` do not need `@moreih29/nexus-core` installed.

Phase 2 대비 (§11.4에서):

> In claude-nexus: add `@moreih29/nexus-core` as a dependency (NOT devDependency — claude-nexus reads the package at runtime, not build time, because Claude Code plugins do not have a build step in the same sense).

세션(plan #1)에서의 해석: 이 구분이 결정적이다.
- opencode-nexus: devDependency → build-time codegen → prompts를 TypeScript 문자열로 inline → 발행 `dist/index.js`에 runtime I/O 없음 → end user는 nexus-core 미설치
- claude-nexus (Phase 2): dependency → runtime 파일 I/O → end user 환경에 nexus-core 설치 필요
- 이 구분이 end user version skew 문제를 차단하는 핵심 메커니즘이다.

---

## §9.2 Runtime 공유 배제

원문 인용 (전문):

> `@moreih29/nexus-core` is a **prompt-only** shared library. The following are explicitly excluded from its scope:
>
> - Hook implementations (`gate.cjs` equivalent for any harness)
> - MCP server implementations (`mcp-server.cjs`)
> - OpenCode plugin tool implementations (`nx_plan_start`, `nx_task_update`, etc.)
> - TypeScript type definitions for runtime types (`NexusAgentProfile`, `NexusAgentCategory`)
> - Any runtime I/O logic
>
> These remain harness-specific. Sharing them would require runtime abstraction layers that are speculative and premature before both harnesses stabilize.

세션(plan #1)에서의 해석: "hook/MCP/tool/runtime code/TypeScript type/I/O logic은 nexus-core에 포함 금지"의 원천. "speculative and premature before both harnesses stabilize" — Option D(Full Shared-Core)가 기각된 논거와 동일한 원칙을 Phase 1 비목표로 재확인.

---

## §11 Phase 2 trigger conditions

원문 인용 — 3개 신호:

> Signal 1 (Commit velocity reversal):
>
> ```
> commits_14d(opencode-nexus) > commits_14d(claude-nexus) × 1.5
> ```
>
> Measured as the number of git commits to each repository in the trailing 14-day window, on any given day. The signal fires when this condition holds for 2 consecutive weeks (14 consecutive days, not rolling average).
>
> Signal 2 (Author declaration):
>
> The author explicitly declares "Phase 2 transition" in one of:
> - A plan session recorded in `.nexus/state/plan.json` of either repository
> - `UPSTREAM.md` in opencode-nexus or claude-nexus
> - A tagged GitHub release note
>
> Signal 3 (Sync direction reversal):
>
> The frequency of "opencode-nexus proposes change → nexus-core" operations exceeds "claude-nexus → nexus-core" operations over a 30-day window.

원문 인용 — trigger rule:

> Phase 2 is triggered when:
>
> ```
> Signal 1 AND (Signal 2 OR Signal 3)
> ```

원문 인용 — 90-day safety rail:

> Regardless of whether the trigger conditions in §11.2 are met, a Phase 2 re-evaluation plan session must be held every 90 days from Phase 1 completion.

**완화 표시**: 이번 세션(plan #1)에서 이 trigger 조건은 엄격 게이트가 아닌 참고 지표로 완화되었다(Primer §5.2). "작성자 판단으로 조기 전환 가능하다." Signal 1(commit velocity 1.5x) + Signal 2(author declaration) or Signal 3(sync direction reversal) 구조는 유지되나, 이를 반드시 충족해야 하는 필수 조건으로 적용하지 않는다.

세션(plan #1)에서의 해석: Issue #3에서 Phase 진입 시점 유연성을 확정하였다.

---

*이 파일: plan session #1, nexus-temp, 2026-04-10. 원본 문서 변경 시 해당 인용 섹션을 업데이트할 것.*
