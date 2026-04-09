# Permission Architecture

Nexus Code의 권한 시스템은 Claude Code CLI의 Pre-tool-use hook을 서버로 라우팅해 **사전 승인 정책 레이어**를 구현한다. 모든 도구 실행은 이 레이어를 통과해야 하며, 평가 결과는 allow / deny / ask(사용자 프롬프트) 세 가지다.

---

## 1. 4개 권한 모드

| 모드 | ID | 설명 |
|------|----|------|
| 기본 | `default` | 위험 작업(편집, 실행, 웹 요청)은 매번 사용자 확인 |
| 편집 허용 | `acceptEdits` | 편집·파일시스템 Bash는 자동 허용, 실행은 확인 |
| 계획 | `plan` | 읽기·탐색만 허용, 편집 계열은 원천 차단 |
| 전체 허용 | `bypassPermissions` | protected path를 제외한 모든 확인 건너뜀 |

모드 메타데이터는 `packages/web/src/constants/permission-modes.ts`의 `PERMISSION_MODES` 배열에 정의되며, 실제 평가 매트릭스는 `packages/server/src/adapters/hooks/approval-bridge.ts`의 `MODE_TOOL_MATRIX`에 구현된다.

permissionMode는 **workspace(global/project) 단위**로 관리된다. `ApprovalBridge`는 매 훅 호출 시 `SettingsStore.getEffectiveSettings(workspacePath)`로 최신 값을 읽으므로 UI에서 모드를 변경하면 다음 도구 호출부터 즉시 반영된다.

---

## 2. 모드×도구 매트릭스

도구 카테고리는 `categorizeToolName()` 함수가 결정한다. Bash는 path-guard의 파싱 결과(`bashFsSubset`, `parseReason`)에 따라 `bash-fs`(파일시스템 부분집합, 파싱 성공) 또는 `bash-other`(파싱 실패 또는 비파일시스템 명령)로 분류된다.

| 도구 카테고리 | 도구 예시 | default | acceptEdits | plan | bypassPermissions |
|--------------|----------|:-------:|:-----------:|:----:|:-----------------:|
| `read` | Read, Grep, Glob, NotebookRead | allow | allow | allow | allow |
| `edit` | Edit, Write, MultiEdit, NotebookEdit | ask | allow | **deny** | allow |
| `bash-fs` | mkdir/touch/rm/mv/cp/sed (cwd 내, 파싱 성공) | ask | allow | ask | allow |
| `bash-other` | 그 외 Bash (파싱 실패 포함) | ask | ask | ask | allow |
| `web` | WebFetch, WebSearch | ask | ask | ask | allow |
| `task` | Task | allow | allow | allow | allow |
| `mcp` | mcp__* | ask | ask | ask | allow |
| `unknown` | 미정의(fail-closed) | ask | ask | ask | allow |

> `plan` 모드에서 `edit` 카테고리는 Step 3에서 `deny`로 즉시 차단된다. 사용자 프롬프트 없이 거부된다.

---

## 3. 평가 파이프라인 (Step 1-7)

```
┌─────────────────────────────────────────────────────────┐
│  CLI: Pre-tool-use hook                                 │
│  HTTP POST /hooks/pre-tool-use                          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  path-guard (hooks.ts → @nexus/shared/path-guard)       │
│  preflightPaths(toolName, toolInput, cwd, roots)        │
│    ├─ extractPaths(toolName, toolInput)                 │
│    │    → { kind:'paths' } | { kind:'unparseable' }    │
│    │       | { kind:'empty' }                           │
│    ├─ normalizePath(~, realpath)                        │
│    ├─ isProtected(absPath, workspaceRoot)               │
│    └─ isWithinAllowedRoots(absPath, cwd + additional)  │
│  출력: { protectedHint[], parseReason?, bashFsSubset }  │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  ApprovalBridge.addPending(approval, meta)              │
│                                                         │
│  Step 1: mode === 'bypassPermissions'?                  │
│    hasProtected → enqueueForUser (사용자 확인)          │
│    else        → allow (즉시 반환)                      │
│                                                         │
│  Step 2: hasProtected?                                  │
│    → enqueueForUser (모든 모드에서 사용자 확인)         │
│                                                         │
│  Step 3: MODE_TOOL_MATRIX[mode][category] === 'deny'?  │
│    → deny (즉시 반환, 사용자 알림 없음)                 │
│                                                         │
│  Step 4: policyStore.matchRule() → 'deny'?             │
│    → deny (저장된 deny 규칙 매칭)                       │
│                                                         │
│  Step 5: policyStore.matchRule() → 'allow'?            │
│    → allow (저장된 allow 규칙 매칭, 감사 로그 기록)    │
│                                                         │
│  Step 6: MODE_TOOL_MATRIX[mode][category] === 'allow'? │
│    → allow (모드 자동 허용)                             │
│                                                         │
│  Step 7: ask → enqueueForUser (pending 큐 진입)        │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  SSE permission_request → Web                           │
│  permission-block (ask) / permission-deny-block (deny) │
│                                                         │
│  사용자 응답: allow | deny + scope(once/session/perm.) │
│  POST /api/workspaces/{path}/approval                   │
│                                                         │
│  → SSE permission_settled → CLI 재개                   │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Protected Paths 가드

`@nexus/shared/src/path-guard.ts`의 `isProtected(absPath, workspaceRoot)` 함수가 판별한다. workspace 외부 경로는 검사 대상이 아니다.

### PROTECTED_DIRS (워크스페이스 상대 경로)

| 경로 | 비고 |
|------|------|
| `.git` | Git 저장소 메타데이터 |
| `.husky` | Git hook 설정 |
| `.nexus/state` | Nexus 런타임 상태(plan.json, tasks.json) |

### PROTECTED_FILES (파일명 일치)

| 파일 | 비고 |
|------|------|
| `.gitconfig` | Git 전역 설정 |
| `.gitmodules` | 서브모듈 설정 |
| `.bashrc` / `.bash_profile` | Bash 쉘 설정 |
| `.zshrc` / `.zprofile` | Zsh 쉘 설정 |
| `.profile` | 공통 쉘 설정 |
| `.mcp.json` | MCP 서버 설정 |
| `.claude.json` | Claude Code 전역 설정 |

### `.env*` 글로브

정규식 `/^\.env(\..+)?$/`에 매칭되는 파일은 모두 protected. `.env`, `.env.local`, `.env.production` 등 포함.

### `.claude` 화이트리스트

`.claude` 디렉토리와 하위 경로는 기본적으로 protected이나, 다음 접두사는 허용된다:

- `.claude/commands`
- `.claude/agents`
- `.claude/skills`
- `.claude/worktrees`

---

## 5. Bash 파서 원칙

`parseBashCommand(command)` 함수(`path-guard.ts`)는 수작업 마이크로 파서다. 외부 런타임 의존성이 없으며 **fail-closed 블랙리스트** 원칙으로 동작한다.

### 허용 명령 (`ALLOWED_COMMANDS`)

`mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`

절대경로(`/bin/rm`), bypass 래퍼(`sudo`, `env`, `exec`, `eval`, `source`, `.`, `doas`, `su`)는 전부 차단된다. 명령에 `/`가 포함된 경우도 차단된다.

### fail-closed 블랙리스트

다음 패턴이 하나라도 감지되면 즉시 `{ kind: 'unparseable', reason: ... }` 반환:

| 패턴 | reason |
|------|--------|
| `$(...)`, `` ` ``, `${...}`, `<(...)`, `>(...)` | `shell-expansion` |
| glob 문자 `*`, `?`, `[` | `shell-expansion` |
| `$VAR`, `${VAR}` 형태 변수 참조 | `variable-expansion` |
| `\|`, `>`, `>>`, `<`, `<<`, `2>`, `&>` | `pipe-or-redirect` |
| `sudo`, `env`, `exec`, `eval` 등 bypass 래퍼 | `bypass-wrapper` |
| ALLOWED_COMMANDS 외 명령 | `unknown-command` |

### 체이닝 처리

`&&`, `;`, `||`로 연결된 복합 명령은 각 세그먼트를 **AND 판정**으로 평가한다. 모든 세그먼트가 허용 명령이고 블랙리스트에 없어야만 경로를 추출한다. 하나라도 실패하면 전체 `unparseable`.

### `sed` 전용 핸들러

`parseSedArgs(args)` 함수가 처리한다.

- `-i` 또는 `-i<suffix>` 플래그가 있어야만 in-place 쓰기로 인식한다.
- `-e <script>`, `-f <scriptfile>` 플래그는 값을 소비(스킵).
- `-i` 없는 `sed`는 읽기 전용이므로 `null` 반환(경로 없음).
- 비플래그 토큰이 여러 개인 경우 첫 번째는 inline 스크립트, 나머지가 파일 경로.

### `ExtractPathsResult` union

```
{ kind: 'paths';       paths: string[]        }  // 경로 추출 성공
{ kind: 'unparseable'; reason: UnparseReason  }  // 안전하게 파싱 불가
{ kind: 'empty' }                                 // 쓰기 대상 없음 (read-only)
```

`unparseable`이 반환되면 `meta.parseReason`에 담겨 `ApprovalBridge`로 전달되고, `categorizeToolName()`이 `bash-other`로 분류한다.

---

## 6. policyStore 규칙 및 specificity

`ApprovalPolicyStore.matchRule(toolName, workspacePath, sessionId)`는 SQLite 쿼리로 규칙을 평가한다.

### 매칭 조건

```sql
WHERE (tool_name = ? OR tool_name = '*')
  AND (workspace_path = ? OR workspace_path IS NULL)
  AND (session_id IS NULL OR session_id = ?)
```

- `tool_name = '*'` 와일드카드 지원
- `workspace_path IS NULL`은 전역 규칙

### specificity 우선순위 (ORDER BY)

1. `workspace_path` 명시 규칙 > 전역 규칙
2. 명시적 `tool_name` > 와일드카드(`*`)
3. `deny` 결정 > `allow` 결정

같은 specificity에서 deny가 allow보다 우선한다.

### 규칙 스코프

| scope | 생명주기 |
|-------|---------|
| `session` | 세션 종료 시 `deleteSessionRules(sessionId)`로 삭제 |
| `permanent` | 사용자가 명시적으로 제거할 때까지 영속 |

---

## 7. UI 진입점

| 컴포넌트 | 역할 |
|---------|------|
| status-bar | 현재 permissionMode 표시 및 전환 |
| 넥서스 탭 (설정 모달) | permissionMode 선택 + disallowedTools 관리 |
| `permission-block` | ask 상태 도구 승인/거부 UI (once / session / permanent 스코프 선택) |
| `permission-deny-block` | deny 결정 결과 표시 (plan 모드 edit 차단 등) |

`permission-block`에서 사용자가 응답하면 `POST /api/workspaces/{path}/approval`로 전송되고, `ApprovalBridge.respond()`가 pending 큐에서 꺼내 처리한 뒤 `permission_settled` SSE를 발행해 CLI를 재개시킨다.
