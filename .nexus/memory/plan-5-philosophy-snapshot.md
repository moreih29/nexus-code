# Plan #5 — Nexus Code 철학 설정 (진행 중 스냅샷, 2026-04-10)

다른 로컬에서 이어갈 때 참고하는 스냅샷. `.nexus/state/plan.json`은 감사 로그고, 이 파일은 "지금까지 뭐 했고 다음에 뭐 할지"의 인간용 요약.

## 세션 개요

- **주제**: Nexus Code 구조·디자인·전략 차원의 프로젝트 철학 설정
- **최종 산출물 합의**: `.nexus/context/` 공식 문서 + CLAUDE.md 요약 (둘 다)
- **접근 방식**: 세 축(architect/designer/strategist) 병렬 투입 + 교차 검증
- **진행 상태**: **2 of 13 decided**

## 13개 이슈 전체 목록 + 추천 순서

| 순서 | ID | 코드 | 제목 | 상태 |
|:-:|:-:|---|---|:-:|
| 1 | 9 | **T1** | Agent Supervisor 페르소나 정의 | ✅ |
| 2 | 13 | **T5** | 경계 외부(Non-goals) 공식화 | ✅ |
| **3** | **11** | **T3** | **핵심 가치 제안** | **⏳ 다음** |
| 4 | 10 | T2 | 경쟁 대비 차별화 포지셔닝 | pending |
| 5 | 12 | T4 | 로드맵 우선순위 | pending |
| 6 | 4 | S4 | 오케스트레이션 기능 배치 전략 | pending |
| 7 | 1 | S1 | 계층 경계와 의존 원칙 | pending |
| 8 | 2 | S2 | 상태 소재 원칙 | pending |
| 9 | 3 | S3 | 외부 경계 격리 (헤드리스 보안/CLI adapter 추상화 포함) | pending |
| 10 | 5 | D1 | 정보 구조(IA) 우선순위 | pending |
| 11 | 8 | D4 | 미팅 워크플로우 UI | pending |
| 12 | 6 | D2 | 인터랙션 원칙 | pending |
| 13 | 7 | D3 | 시각 언어 | pending |

---

## T1 결정 요약 (2026-04-10)

**핵심 페르소나 = "민지" (Indie Hacker / Automation Engineer)**

- 4-7 프로젝트 주 단위 스위칭, 3-6 세션 병렬, 백그라운드 실행 일상
- CLI 능숙, 자동화 광신도, MCP/훅/에이전트 프레임워크 **직접 빌드** (claude-nexus 플러그인 자작)
- **개발자 본인이 민지와 동일 프로필** → dogfooding 기반 PMF 검증
- 2순위 확장: 지민 (솔로 CTO), 민지 PMF 후
- 반대 페르소나: Vibe Coder, 대기업 백엔드, 주니어, 엔터프라이즈 보안

### Core Job (재작성본)

> "여러 Claude Code 세션을 병렬로 돌리면서, 그들의 작업 결과(파일 변경·git 상태·서브에이전트 호출·브라우저 렌더링)를 확인하고 필요할 때 개입하기까지 — 현재는 최소 5-6개 도구(cmux + Claude Code TUI + lazygit + yazi + 크롬 + 에디터)를 오가야 한다. 더 심각한 것은 Claude Code 공식 verbose 모드조차 서브에이전트 출력을 기본 숨긴다는 사실이다. 사용자는 에이전트가 '보고한 것'만 보게 되어 'sanitised & dangerously optimistic' 상태에 빠진다. 이 **도구 파편화 + 가시성 공백**을 하나의 창에서, 에이전트가 일하는 모습이 정보 구조의 중심이 되는 방식으로 해결한다."

**두 축**: (1) 도구 파편화 해소, (2) 가시성 공백 해소.

### Nexus Code 정체성 (T1 확정, T5가 전제)

- **통제 주체** = claude-nexus 같은 **플러그인** (스킬/훅이 런타임 통제 실행)
- **Nexus Code** = 통제의 주체가 **아니라**, 그 과정의 가시화 + 에이전트 감독에 필요한 주변 도구를 통합한 워크벤치
- 한 줄 정체성: **"에이전트 감독자를 위한 통합 워크벤치"**

### 폐기된 이전 가정

- ❌ "사고 없이(안전성)" 축 — Claude Code 기반 + 통제는 플러그인/훅 실행이므로 불가
- ❌ "승인 피로 해소"를 차별점으로 — UX 편의 개선 범주로 격하
- ❌ "Stay in control" 류 통제 주체 메시지

### Core Job 외부 실증

1. **Anthropic 공식 인정**: verbose 모드가 subagent output 숨김 ([The Register 2026-02](https://theregister.com/2026/02/16/anthropic_claude_ai_edits/))
2. **HN "Agents Observe"**: "the only visibility you have is what they choose to report back. Which is often **sanitised and dangerously optimistic**" ([HN #47602986](https://news.ycombinator.com/item?id=47602986))
3. **cmux 제작자**: "routinely 5-10 parallel workstreams … **lose my marbles**"

### 경쟁 매트릭스 (Researcher 2차 확인)

| 기능 | Nexus Code | Nimbalyst | Cursor | Zed | Opcode |
|------|:-:|:-:|:-:|:-:|:-:|
| 멀티 세션 병렬 | ✓ | ✓ | ✓ | ✓ | ✗ |
| 서브에이전트 추적 | ✓ | ⚠️(주장만) | ✗ | ✗ | ✗ |
| 파일 트리/에디터 | ✓ | ✓ (Monaco) | ✓ | ✓ | ✗ |
| git 뷰 | ✓ | ✓ | ✓ | ✓ | ✗ |
| 내장 브라우저 | ✓ | ? | ✗ | ✗ | ✗ |
| 미팅 워크플로우 1급 | ✓ | ✓ (Kanban) | ✗ | ✗ | ✗ |
| 에이전트 중심 IA | ✓ | ✓ | ✗ | ✗ | ✗ |

### Nexus Code 유일 우위 후보 4가지

1. **내장 브라우저** (Electron Chromium)
2. **서브에이전트 추적의 *구체적* 가시화** (Nimbalyst는 "주장"만)
3. **미팅 워크플로우 [plan]→[d]→[run] 1급 시각화**
4. **에이전트 중심 IA 철학 명시**

**신규 경쟁자 주시 대상**: manaflow-ai/cmux (Ghostty + 내장 브라우저), agent-flow, claude-devtools

---

## T5 결정 요약 (2026-04-10)

### Non-goals Top 7

1. **팀/조직 기능 일절 금지** — SSO/RBAC/실시간 공동편집/팀 워크스페이스/PR 협업 UI 모두 NO
2. **비-에이전트 CLI 통합 금지** — Claude Code 1급(현재), **OpenCode 1급 후보**(아키텍처 열어둠), Codex/Gemini 약한 고민, Aider 배제. Claude API 직접 호출·LangChain·AutoGen 통합 금지. "에이전트 코딩 CLI" 카테고리 내에서만
3. **에이전트 조립/빌드 UI 금지** — claude-nexus 같은 플러그인 영역 (MCP 편집기, 스킬 빌더, 훅 에디터 등)
4. **안전성/권한 증강 차별화 금지** — 기술적 불가. UX 편의 개선만. 안전성 홍보 금지
5. **클라우드/호스팅 SKU 금지** — 최소 Phase 4까지. Pro 티어·엔터프라이즈 라이선스 NO
6. **IDE 풀 기능 금지** — LSP/자동완성/포맷터/lint/리팩토링/디버거/빌드. **단 "경량 텍스트 에디터"는 범위 내** (Notepad++ 수준, 사용자 직접 편집 OK)
7. **플러그인 마켓플레이스 금지** — Claude Code 플러그인 생태계 편승

### 범위 내 추가 (T5에서 확정)

- **사용량/비용 대시보드** (read-only 집계, 예산 경보·자동 차단은 NO)
- **알림** (tray/OS notification — 승인 대기, 세션 완료)
- **세션 히스토리 export** (JSON/MD, read-only)
- **Claude Code 공식 기능 GUI 래핑** (`/compact`, `/clear` 등, 덮어쓰기 금지)
- **파일 검색** — "에이전트 로그에서 파일로 jump"만, 전역 검색은 NO
- **헤드리스 서버 모드** — 3계층 아키텍처가 이미 가능케 함. Mac Studio/홈서버에 server만 띄우고 다른 기기 브라우저 접속. 보안/인증은 S3에서 구체화

### 사용자 직접 편집 경계

- ✅ OK: 파일 뷰어+편집+저장, syntax highlight, 파일 트리 CRUD, diff 뷰
- ❌ NO: LSP 자동완성/진단, 포맷터 자동실행, lint 인라인, 리팩토링, 멀티커서, 디버거, 빌드 시스템
- 요약: **Notepad++ 수준 OK, VSCode 경량 버전 NO**

### 판단 규칙 5개 (Architect)

1. **Observer 원칙**: read는 OK 기본, write는 NO 기본. 예외: 경량 텍스트 편집
2. **Plugin boundary 원칙**: 런타임 정책·도구 생성·실행 관여 = NO (claude-nexus 영역), 조회·시각화만 OK
3. **Existing seam 원칙**: 현재 4 패키지·5 adapter(`cli/db/events/hooks/logging`)·11 route에 자연스럽게 들어가면 OK. **새 adapter 카테고리 필요 = 🚨 빨간 불**
4. **Persona fit 원칙**: 민지 주 1회 이상 사용? 아니면 NO
5. **Claude Code override 원칙**: CC 기능 대체 = NO, 래핑·가시화만 OK. OpenCode 등 추가 CLI에도 동일

### Phase별 해제 타임라인

- **Phase 1-2 (현재 ~Year 1)**: 민지 PMF. Claude Code 전용. 모든 non-goal 고정. 타 CLI 아키텍처 추상화만 준비
- **Phase 3 (Year 1-2)**: OpenCode 1급 구현, 로컬 export/import, 헤드리스 공식 문서화, UX 프리셋
- **Phase 4 (Year 2+)**: 지민 확장, Codex/Gemini 재평가, 자체 플러그인 API (초기 기여자 한정)
- **Phase 5+ (Year 3+, 가정)**: 팀 기능 제한적 논의. 전제: 월 DAU 5자리 + 공유 링크 요청 상위 3위 + 이탈 없음. 최초 해제는 로컬 export → 공유 아카이브 번들 (클라우드 ✗)

### 경쟁 침범 결정

- **복제 금지**: Nimbalyst 7종 비주얼 에디터, Nimbalyst iOS, Cursor Background Agents
- **복제 (차별화 형태)**: Monaco(경량만), Visual Git(agent-centric view), 파일 트리, 내장 브라우저, 세션 캔반(미팅 워크플로우 형태)

### 영구 금지 (Phase 5+ 포함 모든 시점)

실시간 공동 편집, SSO/RBAC, 엔터프라이즈 라이선스, Claude API 직접 호출, LangChain/AutoGen 통합, IDE 풀 기능, 에이전트 조립/빌드 UI, Aider 지원

### 쓸 단어 / 쓰지 말 단어

- **쓸**: 가시화, 감독, 통합, 워크벤치, 지켜본다, 파악한다, 통합 뷰, 한 창에서, 에이전트 중심
- **쓰지 말**: 통제(Nexus Code 주체로), 안전(Nexus Code 주체로), Claude Code GUI, 팀, 엔터프라이즈, 자동화

---

## T3 진행 준비 (다음 세션에서 바로 재개할 지점)

### 확정된 재료 (T3가 녹여내야 할 것)

- **정체성**: "에이전트 감독자를 위한 통합 워크벤치"
- **Core Job 두 축**: 도구 파편화 해소 + 가시성 공백 해소
- **유일 우위 4가지**: 내장 브라우저 / 서브에이전트 추적 구체성 / 미팅 워크플로우 1급 / 에이전트 중심 IA
- **피해야 할 표현**: 통제 주체형, 안전/권한 홍보, "Claude Code GUI", 팀/엔터프라이즈, 광범위 "자동화"

### 살아남은 후보 (재검토 대상)

- **옵션 ε**: "See what your agents are doing." (관찰 직설)
- **옵션 ν**: "Your plugins run the agents. Nexus Code shows you everything." (분업 명시)
- **옵션 μ**: "Your agent fleet, in full view." (시야 중심)

### 기각된 이전 옵션 (다시 쓰지 말 것)

- ❌ 옵션 α "승인 피로 없는 병렬 에이전트 워크스테이션" — 안전성 축 폐기로 탈락
- ❌ 옵션 λ "Watch + Step in when it matters" — "when it matters"가 사고 방지 뉘앙스
- ❌ 옵션 δ "Run agents. Stay in control." — "control"이 통제 주체 혼동

### 할 일 (재개 시 바로 실행)

1. strategist 재투입 — T1+T5 전제 반영한 가치 제안 후보 재생성
2. **도구 파편화 + 가시성 이중 축**을 정확히 때리는 새 후보 추가
3. Lead 비교표 + 추천 → 사용자 결정 → [d] 기록

---

## 재개 방법 (다른 로컬에서)

1. `git pull`로 최신 상태 받기
2. `nx_plan_status`로 현재 plan 상태 확인 (`.nexus/state/plan.json`이 이동되어 있을 것)
3. 이 파일 (`plan-5-philosophy-snapshot.md`) + `.nexus/context/` 기존 문서들 + `CLAUDE.md` 읽기
4. `[plan]` 태그로 세션 이어가기
5. Lead가 상태 파악 후 "T3부터 재개" 확인 → strategist 투입

---

## 관련 파일

### 이 저장소 (git 포함, 다른 기기에서 접근 가능)

- `.nexus/state/plan.json` — plan #5 감사 로그 (13 이슈, T1/T5 decided)
- `.nexus/context/architecture.md` — 기존 4계층 구조
- `.nexus/context/session-flow.md` — 세션 생명주기, 이벤트, 권한 흐름
- `.nexus/context/permission-architecture.md` — 권한 시스템 상세
- `.nexus/memory/path-guard-relocation-lessons.md` — cycle #64 교훈

### 로컬 글로벌 메모 (현재 기기에만 존재, `~/.claude/projects/.../memory/`)

- `project_core_persona.md` — 민지 페르소나 + Core Job 상세 (이 스냅샷에 요약 복사됨)
- `project_nexus_role_definition.md` — 역할 정의 + Non-goals 통합본 (T1+T5) — **가장 상세한 최신본**
- `user_developer_profile.md` — 개발자 프로필 (claude-nexus 자작 등)
- `feedback_plan_raw_material_first.md` — plan 세션 원재료 제시 피드백

→ 다른 로컬로 넘어가면 위 글로벌 메모는 읽을 수 없으므로, 중요한 내용은 이 스냅샷에 복사됨. `project_nexus_role_definition.md`의 13개 섹션 상세는 재개 시점에 필요하면 Lead가 이 스냅샷 + plan.json 기반으로 재구성 가능.
