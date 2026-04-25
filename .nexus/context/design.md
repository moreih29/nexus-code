# Design

## 1. 정체성 선언

nexus-code의 디자인 정체성은 **"Linear급 품질의 개발자 워크벤치"**다. 품질·절제·일관성은 자본 진영이 추격할 수 없는 방어선이다.

### 무엇이 아닌가

디자인 결정의 거절선은 다음 세 가지로 확정한다.

1. **에이전트 갤러리·오케스트레이션 UX가 아니다.** 여러 AI 에이전트를 한 화면에서 비교·조율하는 전용 UI는 만들지 않는다. 하네스는 읽기 전용 관찰자.
2. **VS Code 포크가 아니다.** 레이아웃 관용구(activity bar·사이드바·탭바·상태바)는 업계 표준으로 차용하지만, 토큰·타이포·밀도·강조색은 독립 정체성을 갖는다.
3. **터미널 only가 아니다.** xterm 기반 PTY 경험을 핵심 축 중 하나로 제공하지만, Warp·Ghostty·iTerm2 카테고리와는 다른 "IDE급 멀티 워크스페이스 워크벤치"이다.

### 품질 측정 축

"좋아 보임"은 방어선이 될 수 없다. 블록커 수준의 품질 지표는 다음 세 축으로 확정한다.

1. **렌더링 일관성** — 동일 엘리먼트가 모든 상태·모든 패널에서 같은 토큰을 따른다. 마진·패딩·radius·색이 즉흥 드리프트하지 않는다.
2. **입력 지연(keystroke-to-glyph)** — 터미널 키 입력부터 xterm glyph 표시까지의 p95 지연을 기준선으로 삼아 회귀 탐지한다.
3. **한국어 IME 정확도** — 조합 중 Enter 차단·조합 문자 소실 0건·커서 오위치 0건. E2에서 자동 게이트로 닫힌 기준을 품질 측정 축에 정식 편입한다.

### Beachhead 세그먼트

대상 세그먼트는 "**다중 프로젝트를 한 창에서 다루면서 한국어 IME 품질 저하를 못 견디는 개발자**"로 확정한다. 마케팅 슬로건이 아니며 외부 노출을 금지한다.

### 레이아웃 관용구

업계 표준 VS Code계 패턴을 차용하되 오마주·포크 선언을 하지 않는다. 4열 container는 activity bar(좌 끝) + 좌 패널(워크스페이스·파일트리) + 중앙(에디터·터미널) + 우 공유 보조 패널로 구성한다. Activity bar는 아이콘 기반이며 텍스트 라벨은 폐기한다. 탭바·사이드바·상태바는 VS Code의 위치를 따륐되 비주얼은 독립 토큰을 적용한다.

### 구현 관례

토큰 shadcn+oklch, 타이포 Inter+Pretendard fallback, 밀도 기본/컴팩트 2단계(섹션 4), accent 저채도 단일(chroma 0.08~0.12). 상세 섹션 5 참조.

---

## 2. 토큰 시스템

### 구현 방식

Tailwind v4 CSS-first 문법 채택. `packages/app/src/renderer/styles.css`를 `@import "tailwindcss"` + `@theme` 블록으로 교체하고, `packages/app/tailwind.config.ts`는 삭제한다. `@source` 지시자로 CSS 내 content 경로를 이관하며, `@tailwindcss/postcss` + `autoprefixer` 구성은 유지한다.

### 프리미티브 베이스: zinc

블루 틴트 없는 순수 쿨 그레이인 zinc를 프리미티브 베이스로 확정한다. shadcn 기본값과 정합하여 CLI 마찰 0. 기존 slate를 zinc로 전환하며 프리미티브는 Tailwind 기본 팔레트를 재사용하고 시맨틱 토큰만 정의한다.

### Accent: Terminal Teal

강조색은 `oklch(0.70 0.10 195)`로 확정한다. 16진 근사는 `#3aa0a6`이다. chroma 0.08~0.12 범위 내이며 VS Code blue(hue ~245)와 Cursor 별라(hue ~290)를 회피한다. 터미널 전통 청록과 연결되며 다크·라이트 대비 계산이 안정적이다. WCAG AA는 토큰 주입 후 브라우저에서 확인한다.

### 시맨틱 토큰

shadcn 명칭 체계를 전체 수용한다. 기본 시맨틱은 background·foreground·card·card-foreground·popover·popover-foreground·primary·primary-foreground·secondary·secondary-foreground·muted·muted-foreground·accent·accent-foreground·destructive·destructive-foreground·border·input·ring이다. sidebar 확장은 sidebar·sidebar-foreground·sidebar-border. E3 하네스 상태 확장은 status-running(`oklch(0.75 0.12 150)`), status-idle(`var(--color-zinc-500)`), status-error(`var(--color-destructive)`). 기타: radius는 `0.5rem`(8px, shadcn 기본 `0.625rem`보다 1단계 타이트), color-scheme은 `dark`.

### @theme 샘플

```css
@import "tailwindcss";
@theme {
  --color-background: var(--color-zinc-950);
  --color-foreground: var(--color-zinc-50);
  --color-primary: oklch(0.70 0.10 195);
  --color-secondary: var(--color-zinc-800);
  --color-muted: var(--color-zinc-800);
  --color-accent: var(--color-zinc-800);
  --color-destructive: var(--color-red-500);
  --color-border: var(--color-zinc-800);
  --color-ring: oklch(0.70 0.10 195);
  --color-sidebar: var(--color-zinc-950);
  --color-status-running: oklch(0.75 0.12 150);
  --radius: 0.5rem;
}
```

### 다크 우선·라이트 모드 준비

MVP는 다크 모드 단일로 고정하며 라이트 모드는 v0.2에서 `.dark` 블록 분리로 확장. 테마는 향후 쉽게 교체·확장 가능한 것이 `@theme` 채택의 핵심이므로 초기 값 확정은 보수적으로 유지한다.

### Monaco 테마 브리지

Monaco `defineTheme`은 hex만 수용. CSS 변수 oklch→hex 브리지는 E4에서 별도 구축.

---

## 3. 타이포그래피

### UI 폰트와 xterm 폰트의 의도적 분리

UI sans는 Inter Variable + Pretendard Variable(KR subset)로 버튼·라벨·본문·헤더·패널 제목에 사용한다. UI mono는 JetBrains Mono Variable로 inline code·단축키·상태바 PID·경로·크기에 사용한다. xterm은 D2Coding + Noto Sans KR(기존) 유지하며 터미널 전용 한글 정렬 품질 절대 우선.

### UI sans 스택

`"Inter"`, `"Pretendard Variable"`, `"Pretendard"`, `ui-sans-serif`, `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `"Apple SD Gothic Neo"`, `"Malgun Gothic"`, `"Segoe UI"`, `sans-serif`

Inter와 Pretendard는 x-height·베이스라인 드리프트 최소화로 한영 혼용 안정성 검증.

### UI mono 스택

`"JetBrains Mono"`, `"D2Coding"`, `"Pretendard Variable"`, `ui-monospace`, `SFMono-Regular`, `Menlo`, `Monaco`, `Consolas`, `"Liberation Mono"`, `"Courier New"`, `monospace`

xterm `--nx-terminal-font-family`는 기존값 유지. UI mono와 터미널 mono는 의도적으로 다르다.

### 크기 스케일

base 13px 확정. 7단계 스케일은 xs 11px·sm 12px·base 13px·md 14px·lg 16px·xl 20px·2xl 24px.

### 행높이 3단

행높이는 tight 1.25(헤더·`text-lg` 이상)·normal 1.45(UI 본문 기본)·relaxed 1.6(긴 설명문) 3단으로 확정한다. normal 1.45는 한글 글리프 세로 공간을 고려한 한영 혼용 하한선이다.

### 폰트 특성 기본값

- **리가처 OFF** (기본). CLI 문자 경계 흐림, 스크린리더·커서 폭 계산 리스크, 개발자 선호 갈림을 이유로 차단한다. 향후 설정 토글로 opt-in 가능하나 별도 이슈 백로그로 관리한다.
- **tabular-num 전역 OFF**. 상태바(PID·파일크기·메모리·시간), 테이블 숫자 컬럼, 진행률 %, 터미널 탭 번호에만 선택 적용한다. 유틸리티 `.nx-tabular` 제공.
- **Inter font-feature-settings**: `"cv11"` (단층 `a` 판독성) + `"ss01"` (개방형 기호)

---

## 4. 레이아웃·밀도·상호작용

### 4열 컨테이너

Activity bar 48px(3rem) 고정·리사이즈 불가. Workspace 사이드바 기본 17rem, 범위 12~28rem, `Cmd+B`로 collapse, `localStorage` 지속. Center는 fluid(minmax(0, 1fr)). Shared panel 기본 20rem, 범위 16~32rem, `Cmd+J`로 collapse, `localStorage` 지속. 구현은 `react-resizable-panels`(shadcn Resizable 래퍼)를 채택한다. 리사이저 접근성은 `role="separator"`·`aria-valuenow`·화살표 키(±16px)·focus ring 2px.

### 아이콘 시스템

`lucide-react`를 채택한다. shadcn/ui 공식 선택이며 tree-shaking으로 30~50개 사용 시 ~15KB gzip이다. stroke-width는 1.75(Linear 값)로 확정하고 기본 16px·Activity bar 20px로 구분. 고정 매핑: close=X·add=Plus·folder=Folder/FolderOpen·search=Search·git=GitBranch·terminal=SquareTerminal·command=Command·settings=Settings·chevron=ChevronRight/ChevronDown. empty state: Wrench(tool)·History(session)·GitCompare(diff)·Eye(preview)

### Primitive 높이

Button h-8(32px)·Tab h-9(36px)·Checkbox 16px·Icon button 28px 확정.

### Empty state 구조

모든 패널 empty state는 통일된 4단 구조: 24px stroke icon(muted-foreground) + text-sm font-medium 제목(명사) + text-xs text-muted-foreground 1줄 설명 + 조건부 Button sm 또는 kbd 힌트.

패널별 문구: Workspace(FolderOpen,No workspace open,Open folder+Cmd+O)·Terminal(SquareTerminal,Open workspace to start terminal)·File tree E4 전(Folder,Files appear here)·Tool E3 전(Wrench,Agent tool invocations appear here)·Session E3 전(History,No session history)·Diff E3 전(GitCompare,No changes)·Preview E5 전(Eye,Preview unavailable).

"Coming soon" 문구는 금지하며, 미구현 패널은 기능 가치를 한 문장 서술한다. 일러스트는 사용하지 않는다. a11y 원칙: 아이콘은 aria-hidden, 제목이 스크린리더 앵커, 버튼 텍스트는 구체적이다.

### Border·Spacing

Border 1px 고정. Focus ring만 2px 예외 허용. Spacing은 Tailwind 기본 4px 단위 유지.

### Command palette

MVP에 `cmdk` command palette를 포함한다. `Cmd+P`와 `Cmd+Shift+P`는 동일 팔레트이며 `>` 접두어로 모드 분기한다. MVP 명령 10개: Workspace Switch·Open·Close, View Toggle Sidebar·Toggle Shared Panel·Focus Terminal, Terminal New Tab·Close Tab, App Reload·Preferences placeholder. 파일 모드는 E4에서 확장한다.

### 단축키 맵

다음 11개 단축키를 MVP 단일 레지스트리에 바인딩: `Cmd+O`(Workspace 열기), `Cmd+1/2/3`(워크스페이스 탭 전환), `Cmd+W`(닫기), `Cmd+T`(새 터미널 탭), `Cmd+Shift+[/]`(이전/다음 탭), `Cmd+B`(Workspace 사이드바 토글), `Cmd+J`(Shared panel 토글), `Cmd+P`/`Cmd+Shift+P`(팔레트 열기), ``Ctrl+` ``(터미널 포커스), `Esc`(팔레트·오버레이 닫기).

---

## 5. 금지 시각 언어

다음 시각 요소와 표현은 전면 금지:

1. **글래스모피즘** — 투명도 블러는 정보 밀도와 접근성 대비를 해친다.
2. **corner smoothing 라이브러리** — Squircle 등 외부 곡률 보정은 ROI가 낮고 빌드 복잡도만 증가한다.
3. **보라 그라디언트** — AI 도구 카테고리의 진부한 클리셰이며 Cursor·Copilot 등이 이미 소모했다.
4. **네온 액센트** — 발광 효과와 채도 과잉은 품질·절제 축과 정면으로 배치.
5. **일러스트** — AI 생성 이미지나 벡터 일러스트 empty state 장식은 정보 전달 가치가 없다.
6. **"Coming soon" 문구** — 미구현 기능에 대한 희망 고문이다. 기능 가치를 구체적으로 서술하거나 empty state 구조로 대체한다.
7. **2px border 강조(side-stripe 슬롭)** — 좌측·상단 두꺼운 테두리 강조는 VS Code 확장 카드 스타일의 저급 강조.
8. **장식용 컬러 아이콘** — 아이콘에 임의의 채색을 입히는 행위를 금지하며 모든 아이콘은 단색 stroke로 통일한다.
9. **stroke 두께 2종 혼용** — 동일 맥락에서 서로 다른 stroke-width를 섞어 쓰는 것을 금지한다. 1.75 단일 값으로 통일하되, Activity bar 20px 크기에 따른 시각 보정은 허용한다.

---

## 6. AI 터미널·E3 국소 차별화 원칙

Warp 감성은 지역적 디테일로만 적용하고 block-based UI 전면 복제는 E3 초과이다.

### 세션 경계선

터미널 세션 구분은 subtle divider로 처리한다. 과장된 그림자나 색 대비 없이 1px border 토큰 수준에서 표현한다.

### 하네스 상태 뱃지

하네스 상태는 3상태 뱃지로 요약하며 상태 색은 저채도 제한.

- **running** — `oklch(0.75 0.12 150)` (차분한 녹)
- **idle** — `var(--color-zinc-500)`
- **error** — `var(--color-destructive)`

### tool 호출 하이라이트

하네스가 tool을 호출할 때 해당 터미널 영역에 subtle highlight를 적용한다. 전체 block 감싸기가 아닌, 터미널 내 텍스트 흐름을 해치지 않는 최소 범위의 배경색 변화만 허용.

### block-based terminal 전면 복제 금지

Warp의 block 기반 터미널 UI를 xterm.js 위에 별도 레이어로 재현하는 시도는 금지한다. 커스텀 렌더러나 DOM 오버레이 대규모 설계를 요구하며 E3 범위를 명시적으로 초과한다. 차별화는 "경계선·뱃지·subtle highlight" 3요소로만 한정한다.
