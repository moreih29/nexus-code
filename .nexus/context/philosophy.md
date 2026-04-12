# Philosophy — Nexus Code

Nexus Code의 정체성, 경계, 판단 기준을 정의하는 영속 선언문이다.

---

## (1) 정체성

### What

**"에이전트 감독자를 위한 통합 워크벤치"**

Core Job은 두 축으로 구성된다.

**(i) 도구 파편화 해소**
민지는 현재 최소 5-6개 도구(cmux + Claude Code TUI + lazygit + yazi + 크롬 + 에디터)를 오가며 병렬 에이전트 세션을 관리한다. 이 파편화를 한 창에서 해소한다. 에이전트가 일하는 모습이 정보 구조의 중심이다.

**(ii) 가시성 공백 해소**
Claude Code verbose 모드조차 서브에이전트 출력을 기본 숨긴다. 사용자는 에이전트가 "보고한 것"만 보게 되어 'sanitised & dangerously optimistic' 상태에 빠진다. 이 가시성 공백을 시각화로 해소한다.

### Where

Nexus 생태계의 **Supervision layer**다. Authoring layer(nexus-core — read-only consumer)와 Execution layer(claude-nexus ↔ opencode-nexus sibling, bidirectional flip) 사이가 아니라, flip **외부**에 독립 위치한다. 여러 Execution layer 세션을 동시에 감독할 수 있는 별도 층위다.

---

## (2) Supervision 이중 성격

nexus-code는 단순 관찰자가 아닌 Supervisor다. 이중 성격을 모두 가진다.

**(a) 세션 관찰자 측면**
Execution layer 세션 프로세스의 상태, 메시지 스트림, 파일 변경 사항을 read-only로 관찰한다.

**(b) Policy Enforcement Point 측면**
에이전트가 요청하는 권한(파일 수정, 셸 명령 등)에 대해 Pre-tool-use hook + ApprovalBridge로 승인/거부 결정을 내린다.

**구조적 기원**: Claude Code CLI는 비대화형이므로 "권한 요청→승인→실행" 흐름을 대화형으로 이을 수 없다. 외부 감독자(nexus-code)가 ApprovalBridge로 결정 지점을 담당하는 것은 우회로가 아니라 구조적 필연이다.

---

## (3) 민지 페르소나

### 핵심 페르소나 — 민지 (Indie Hacker / Automation Engineer)

- 4-7 프로젝트 주 단위 스위칭, 3-6 세션 병렬, 백그라운드 실행 일상
- CLI 능숙, 자동화 광신도, MCP/훅/에이전트 프레임워크 직접 빌드 (claude-nexus 플러그인 자작)
- 개발자 본인이 민지와 동일 프로필 → dogfooding 기반 PMF 검증

### 2순위 확장 — 지민 (솔로 CTO)

민지 PMF 후 Phase 4에서 재평가한다.

### 반대 페르소나 (타겟 아님)

Vibe Coder, 대기업 백엔드 개발자, 주니어 개발자, 엔터프라이즈 보안 담당자.

---

## (4) Non-goals Top 7

### 영구 금지

1. **팀/조직 기능 일절 금지** — SSO, RBAC, 실시간 공동편집, 팀 워크스페이스, PR 협업 UI 모두 NO
2. **비-에이전트 CLI 통합 금지** — Claude Code 1급(현재), OpenCode 1급 후보(아키텍처 열어둠), Codex/Gemini 약한 고민, Aider 배제. Claude API 직접 호출·LangChain·AutoGen 통합 금지. "에이전트 코딩 CLI" 카테고리 내에서만.
3. **에이전트 조립/빌드 UI 금지** — claude-nexus 같은 플러그인 영역(MCP 편집기, 스킬 빌더, 훅 에디터 등). Authoring layer 침범 방지.
4. **안전성/권한 증강 차별화 금지** — 기술적 불가. UX 편의 개선만. 안전성 홍보 금지.
5. **클라우드/호스팅 SKU 금지** — 최소 Phase 4까지. Pro 티어·엔터프라이즈 라이선스 NO.
6. **IDE 풀 기능 금지** — LSP/자동완성/포맷터/lint/리팩토링/디버거/빌드. 단 **경량 텍스트 에디터**는 범위 내(Notepad++ 수준, 사용자 직접 편집 OK).
7. **플러그인 마켓플레이스 금지** — Claude Code 플러그인 생태계 편승.

### 범위 내 추가 (T5 확정)

- **사용량/비용 대시보드** — read-only 집계. 예산 경보·자동 차단은 NO.
- **알림** — tray/OS notification (승인 대기, 세션 완료)
- **세션 히스토리 export** — JSON/MD, read-only
- **Claude Code 공식 기능 GUI 래핑** — `/compact`, `/clear` 등. 덮어쓰기 금지.
- **파일 검색** — "에이전트 로그에서 파일로 jump"만. 전역 검색은 NO.
- **헤드리스 서버 모드** — 3계층 아키텍처가 이미 가능케 함. Mac Studio/홈서버에 server만 띄우고 다른 기기 브라우저 접속. 보안/인증은 S3 안건에서 구체화.

---

## (5) 5 판단 규칙

**1. Read-default / Write-exception 원칙**
(이것은 T5의 "Observer 원칙"을 재명시한 이름이다. Plan Session #1이 확정한 "Supervision 이중 성격"과의 일관성을 위해 Observer 명칭을 사용하지 않는다.)

read는 OK 기본, write는 NO 기본. **예외**: 경량 텍스트 편집 — 파일 뷰어+편집+저장, syntax highlight, 파일 트리 CRUD, diff 뷰.

NO: LSP 자동완성/진단, 포맷터 자동실행, lint 인라인, 리팩토링, 멀티커서, 디버거, 빌드 시스템.

요약: "Notepad++ 수준 OK, VSCode 경량 버전 NO".

**2. Plugin boundary 원칙**
런타임 정책·도구 생성·실행 관여 = NO (claude-nexus 영역). 조회·시각화만 OK. nexus-core에 쓰기 기여 금지. 에이전트 정의 편집 UI 금지.

**3. Existing seam 원칙**
현재 4 패키지(shared/server/web/electron) · 5 adapter 카테고리(cli/db/events/hooks/logging) · 11 route에 자연스럽게 들어가면 OK. **새 adapter 카테고리 필요 = 빨간 불**. 신규 경계는 재검토 대상.

**4. Persona fit 원칙**
민지가 주 1회 이상 사용? 아니면 NO. 민지 동선에 없는 기능은 범위 밖.

**5. Claude Code override 원칙**
CC 기능 대체 = NO. 래핑·가시화만 OK. OpenCode 등 추가 CLI에도 동일. Supervision layer는 Execution layer 기능을 복제하지 않는다.

---

## (6) 쓸 단어 / 쓰지 말 단어

**쓸**: 가시화, 감독, 통합, 워크벤치, 지켜본다, 파악한다, 통합 뷰, 한 창에서, 에이전트 중심, Policy Enforcement Point

**쓰지 말**: 통제(Nexus Code 주체로), 안전(Nexus Code 주체로), Claude Code GUI, 팀, 엔터프라이즈, 자동화(광범위), Observer

---

## (7) Phase 해제 타임라인

| Phase | 시점 | 내용 |
|-------|------|------|
| **Phase 1-2** | 현재 ~ Year 1 | 민지 PMF. Claude Code 전용. 모든 non-goal 고정. 타 CLI 아키텍처 추상화만 준비 (AgentHost 인터페이스). |
| **Phase 3** | Year 1-2 | OpenCode 1급 구현, 로컬 export/import, 헤드리스 공식 문서화, UX 프리셋. |
| **Phase 4** | Year 2+ | 지민 확장, Codex/Gemini 재평가, 자체 플러그인 API (초기 기여자 한정). |
| **Phase 5+** | Year 3+ (가정) | 팀 기능 제한적 논의. 전제: 월 DAU 5자리 + 공유 링크 요청 상위 3위 + 이탈 없음. 최초 해제는 로컬 export → 공유 아카이브 번들 (클라우드 불가). |

---

## Plan #5 재개 경로

Plan #5 철학 세션의 13 이슈 중 T1/T5 두 건이 결정되어 이 문서로 이관되었다. 남은 11 이슈는 3개 묶음으로 재개된다.

### 묶음 1 — 가치 제안 계열 (owner: strategist)

- T3 핵심 가치 제안 / T2 경쟁 대비 차별화 포지셔닝 / T4 로드맵 우선순위
- **Trigger**: Phase 2 완료 (Task A agent-host.ts 신설 + Task C-spike claude-code-host.ts + tester 검증)
- 이 묶음 완료 시점에 CLAUDE.md 정체성 문구를 최종 tagline으로 격상

### 묶음 2 — 아키텍처 원칙 계열 (owner: architect)

- S1 계층 경계와 의존 원칙 / S2 상태 소재 원칙 / S3 외부 경계 격리(헤드리스 보안 포함) / S4 오케스트레이션 기능 배치 전략
- **Trigger**: Phase 3 완료 (Task B nexus-core consumer 합류) — AgentHost/nexus-core 실구현 검증을 전제로 원칙 도출

### 묶음 3 — 디자인 계열 (owner: designer)

- D1 정보 구조(IA) 우선순위 / D4 미팅 워크플로우 UI / D2 인터랙션 원칙 / D3 시각 언어
- **Trigger**: 묶음 1 완료 후 — 가치 제안 확정 후 UX 결정

---

*문서 버전: Plan #5 T1/T5 + Plan Session #1 결정 이관, 2026-04-10. 이 문서는 `.nexus/context/` 내부 문서로, 3층위 용어(Authoring/Supervision/Execution) 사용이 허용된다.*
