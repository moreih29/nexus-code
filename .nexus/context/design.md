# Design

>> 현재 구현 상태는 roadmap.md를 참조하세요. 세부 사양은 아래 분리 문서를 우선합니다.

## 문서 지도

- [design-tokens.md](./design-tokens.md) — 토큰, 타이포그래피, 아이콘, border/spacing.
- [design-layout.md](./design-layout.md) — 4 zone 워크벤치, flexlayout grid, Bottom Panel, active/focus 표시.
- [design-interactions.md](./design-interactions.md) — 단축키, command palette, file tree 조작, ARIA.
- [design-components.md](./design-components.md) — FileTree toolbar, empty state, 하네스 tool highlight.
- [design-architecture.md](./design-architecture.md) — renderer service/parts 경계와 design-facing 테스트 정책.

## 1. 정체성 선언

nexus-code의 디자인 정체성은 **Linear급 품질의 멀티 워크스페이스 개발자 워크벤치**다. 단일 프로젝트 편집기가 아니라 여러 프로젝트를 한 창에서 전환·관찰·편집하는 작업대이며, 품질·절제·일관성이 방어선이다.

차별화 축은 세 가지다.

1. **멀티 워크스페이스** — 열린 워크스페이스의 소유 관계와 상태를 첫 번째 내비게이션 표면에서 드러낸다.
2. **3-하네스 관찰** — claude-code, opencode, codex 계열 하네스는 오케스트레이션 대상이 아니라 읽기 전용 관찰 대상이다.
3. **한국어 IME·렌더링 품질** — 한영 혼용, 조합 입력, xterm glyph 표시가 제품 품질의 1급 기준이다.

VSCode보다 작은 제품을 목표로 하지 않는다. 편집·LSP·검색·git·diff·탭/트리 상호작용·레이아웃·키바인딩의 능력 표면은 VSCode 상위호환을 목표로 한다. 단, VSCode 코드 포크도 오마주 UI도 아니다. 토큰·타이포그래피·강조색·밀도·하네스 관찰·멀티 워크스페이스 모델은 자체 언어로 유지한다.

Plan #33 이후 설계 충돌은 한 사이클에서 통합한다. 부분 호환을 남겨 “이전 구조와 새 구조가 공존하는” 상태를 만들지 않는다.

## 2. 무엇이 아닌가

1. **에이전트 갤러리·오케스트레이션 UX가 아니다.** 여러 AI 에이전트를 비교·지휘하는 UI를 만들지 않는다. 하네스는 관찰 신호를 제공할 뿐이다.
2. **VS Code 코드 포크가 아니다.** Monaco와 표준 라이브러리를 사용하되, 코드·브랜드·시각 언어를 포크하지 않는다.
3. **터미널 only가 아니다.** xterm 기반 PTY 경험은 핵심 축이지만 Warp·Ghostty·iTerm2 카테고리와는 다른 IDE급 워크벤치다.
4. **일회성 데모 shell이 아니다.** renderer 구조와 회귀 가드는 장기적으로 기능을 붙일 수 있는 형태여야 한다.

## 3. 품질 측정 축

“좋아 보임”은 방어선이 될 수 없다. 블록커 수준 품질 지표는 다음 세 축이다.

1. **렌더링 일관성** — 동일 엘리먼트가 모든 상태·패널에서 같은 토큰을 따른다. 마진·패딩·radius·색은 즉흥 드리프트하지 않는다.
2. **입력 지연(keystroke-to-glyph)** — 터미널 키 입력부터 xterm glyph 표시까지의 p95 지연을 기준선으로 삼아 회귀 탐지한다.
3. **한국어 IME 정확도** — 조합 중 Enter 차단, 조합 문자 소실 0건, 커서 오위치 0건을 기준으로 한다.

## 4. Beachhead 세그먼트

대상 세그먼트는 **다중 프로젝트를 한 창에서 다루면서 한국어 IME 품질 저하를 못 견디는 개발자**다. 이는 내부 의사결정 기준이며 외부 마케팅 문구로 노출하지 않는다.

## 5. 금지 시각 언어

다음 표현은 전면 금지한다.

1. **글래스모피즘** — 투명도 블러는 정보 밀도와 대비를 해친다.
2. **corner smoothing 라이브러리** — 외부 곡률 보정은 ROI가 낮고 빌드 복잡도만 증가시킨다.
3. **보라 그라디언트** — AI 도구 카테고리의 진부한 클리셰다.
4. **네온 액센트** — 발광 효과와 채도 과잉은 절제 축과 배치된다.
5. **일러스트** — empty state 장식은 정보 전달 가치가 없다.
6. **“Coming soon” 문구** — 기능 가치를 구체적으로 서술하거나 empty state 구조로 대체한다.
7. **2px border 강조(side-stripe 슬롭)** — 강조는 두꺼운 선이 아니라 배경·텍스트·토큰 대비로 해결한다.
8. **장식용 컬러 아이콘** — 색은 파일 타입 식별처럼 정보 전달 목적일 때만 허용한다.
9. **stroke 두께 2종 혼용** — 동일 맥락의 아이콘 stroke는 단일 값으로 유지한다.

## 6. AI 터미널·국소 차별화 원칙

Warp 감성은 지역적 디테일로만 적용한다. block-based terminal UI를 xterm.js 위에 별도 레이어로 전면 재현하는 시도는 MVP 범위를 초과하므로 금지한다.

차별화는 세 요소로 제한한다.

1. 세션 경계선은 subtle 1px divider로 처리한다.
2. 워크스페이스 상태는 Workspace strip의 조용한 상태 뱃지로 드러낸다.
3. 하네스 tool 호출은 텍스트 흐름을 해치지 않는 최소 highlight만 허용한다.

## 7. 설계 문서 운영 원칙

이 문서는 철학만 보존한다. 치수·단축키·컴포넌트·service/test 정책은 세부 문서에서만 정의한다.

같은 사양을 두 문서에 반복하지 않는다. 철학 문서가 실행 사양을 설명해야 할 때는 값 대신 링크를 둔다.
