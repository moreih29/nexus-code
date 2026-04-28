# Design

>> 현재 구현 상태는 roadmap.md를 참조하세요.

## 1. 정체성 선언

nexus-code의 디자인 정체성은 **"Linear급 품질의 개발자 워크벤치"**다. 품질·절제·일관성은 자본 진영이 추격할 수 없는 방어선이다.

### 무엇이 아닌가

디자인 결정의 거절선은 다음 세 가지로 확정한다.

1. **에이전트 갤러리·오케스트레이션 UX가 아니다.** 여러 AI 에이전트를 한 화면에서 비교·조율하는 전용 UI는 만들지 않는다. 하네스는 읽기 전용 관찰자.
2. **VS Code 코드 포크가 아니다.** 엔지니어링 의미에서는 VSCode 코드를 포크하지 않고 Monaco와 표준 라이브러리를 사용한다. 포지셔닝 의미에서는 능력 표면—편집·LSP·검색·git·diff·탭/트리 상호작용·레이아웃·키바인딩—이 VSCode 수준을 목표로 한다. 차별화는 토큰·타이포·밀도·강조색·AI 하네스 관찰 통합·멀티 워크스페이스 모델에서 만든다.
3. **터미널 only가 아니다.** xterm 기반 PTY 경험을 핵심 축 중 하나로 제공하지만, Warp·Ghostty·iTerm2 카테고리와는 다른 "IDE급 멀티 워크스페이스 워크벤치"이다.

### 품질 측정 축

"좋아 보임"은 방어선이 될 수 없다. 블록커 수준의 품질 지표는 다음 세 축으로 확정한다.

1. **렌더링 일관성** — 동일 엘리먼트가 모든 상태·모든 패널에서 같은 토큰을 따른다. 마진·패딩·radius·색이 즉흥 드리프트하지 않는다.
2. **입력 지연(keystroke-to-glyph)** — 터미널 키 입력부터 xterm glyph 표시까지의 p95 지연을 기준선으로 삼아 회귀 탐지한다.
3. **한국어 IME 정확도** — 조합 중 Enter 차단·조합 문자 소실 0건·커서 오위치 0건. 터미널 자동 게이트로 닫힌 기준을 품질 측정 축에 정식 편입한다.

### Beachhead 세그먼트

대상 세그먼트는 "**다중 프로젝트를 한 창에서 다루면서 한국어 IME 품질 저하를 못 견디는 개발자**"로 확정한다. 마케팅 슬로건이 아니며 외부 노출을 금지한다.

### 레이아웃 관용구

업계 표준 VS Code계 패턴을 차용하되 오마주·포크 선언을 하지 않는다. 4열 container는 Workspace strip(워크스페이스 식별·전환) + Filetree column(활성 워크스페이스 파일트리) + Center workbench(에디터·터미널) + Shared panel로 구성하며, 좌단 아이콘 전용 바는 두지 않는다. 탭바·사이드바·상태바의 위치 관용구는 참고하되 비주얼은 독립 토큰을 적용한다.

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

shadcn 명칭 체계를 전체 수용한다. 기본 시맨틱은 background·foreground·card·card-foreground·popover·popover-foreground·primary·primary-foreground·secondary·secondary-foreground·muted·muted-foreground·accent·accent-foreground·destructive·destructive-foreground·border·input·ring이다. sidebar 확장은 sidebar·sidebar-foreground·sidebar-border. 하네스 상태 확장은 status-running(`oklch(0.75 0.12 150)`)과 status-attention(`oklch(0.78 0.12 75)`)이다. error는 destructive를 재사용하고, completed는 별도 토큰 없이 무뱃지로 접는다. 기타: radius는 `0.5rem`(8px, shadcn 기본 `0.625rem`보다 1단계 타이트), color-scheme은 `dark`.

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
  --color-status-attention: oklch(0.78 0.12 75);
  --radius: 0.5rem;
}
```

### 다크 우선·라이트 모드 준비

MVP는 다크 모드 단일로 고정하며 라이트 모드는 v0.2에서 `.dark` 블록 분리로 확장. 테마는 향후 쉽게 교체·확장 가능한 것이 `@theme` 채택의 핵심이므로 초기 값 확정은 보수적으로 유지한다.

### Monaco 테마 브리지

Monaco `defineTheme`은 hex만 수용한다. `MonacoEditorHost`는 `nexus-dark`를 고정 hex 값으로 정의하며, CSS oklch 토큰 값은 Monaco에 직접 전달하지 않는다.

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

Container는 좌→우 narrative를 가진 네 열로 고정한다: Workspace strip 기본 160px(범위 120–220px), Filetree column 기본 240px(범위 200–400px), Center fluid(`minmax(0, 1fr)`), Shared panel 기본 20rem(범위 16–32rem). Workspace strip과 Filetree column은 `Cmd+B`로 함께 collapse하며 각 폭은 `localStorage`에 지속한다. Shared panel은 `Cmd+J`로 collapse하고 폭을 `localStorage`에 지속한다. Shared panel 탭은 Tool / Session / Source Control / Preview / Search의 5개로 고정한다. Source Control은 기존 Diff 슬롯을 진화시킨 탭이며 git status, staged changes, branch indicator, inline commit, Center diff editor 연결을 담당한다.

Workspace strip은 열린 워크스페이스의 소유 관계를 드러내는 식별·전환 표면이다. 모든 열린 워크스페이스를 수직 리스트로 표시하고, active state는 `bg-accent` + `ring-1 ring-primary/30`로 표현한다. Filetree column은 활성 워크스페이스의 파일트리만 표시한다. Filetree header는 active workspace 이름과 `FolderOpen` 아이콘을 다시 보여 주어 “이 파일트리는 현재 워크스페이스 소유”라는 cue를 제공한다.

워크스페이스가 0개일 때는 Workspace strip만 EmptyState를 표시하고 Filetree column은 숨긴다. 10개 이상 워크스페이스는 Workspace strip 내부 스크롤로 처리하며 `Cmd+1/2/3` 전환 시 활성 항목을 `scrollIntoView({ block: "nearest" })`로 보정한다.

### Center workbench

Center는 split을 기본 상태로 사용한다. Editor pane은 위, Terminal pane은 아래에 놓으며 두 pane은 항상 mounted 상태를 유지한다. 수평 divider는 공통 resizer spec을 따르되 `cursor: row-resize`와 `aria-orientation="horizontal"`을 사용한다. Active pane은 `box-shadow: inset 0 0 0 1px var(--color-ring)`으로 표시하고, §5의 side-stripe·두꺼운 border 강조 금지선을 따른다.

각 pane header 우상단에는 `Maximize2`/`Minimize2` 16px ghost icon action을 둔다. `Cmd+Shift+M`은 현재 pane maximize toggle이다. Split ratio는 `nx.center.split.ratio`로 영속하며 기본값은 editor 0.6 / terminal 0.4다. Terminal pane의 최소 높이는 120px로 clamp한다.

Editor pane 내부 split은 1-depth horizontal split만 지원한다. 좌/우 두 pane과 pane별 탭바까지가 MVP 범위이며, multi-depth split과 grid layout은 v0.2 결정 영역으로 미룬다. Editor pane tab은 일반 file tab과 diff tab을 가진다. diff tab은 Compare with Selected와 Source Control의 View Diff가 여는 공통 표면이며, `GitCompare` 16px 단색 아이콘과 `{name1} ↔ {name2}` title format으로 일반 파일 탭과 구분한다.

### Resizer

Panel resize handle은 custom pointer handler 위의 단일 컴포넌트로 통일한다. 시각 선은 1px(`bg-border`)이고 실제 hit area는 `::before` pseudo-element로 8px를 제공한다. Hover는 100ms delay 후 `bg-primary`로 전환하고, drag 중에는 delay 없이 즉시 `bg-primary`를 사용한다. Focus는 `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1`로 표시한다. `GripVertical` 아이콘과 안쪽 박스 wrapper는 사용하지 않는다.

Vertical divider는 `cursor: col-resize`, horizontal divider는 `cursor: row-resize`를 사용한다. 모든 divider는 `role="separator"`와 방향별 `aria-orientation`을 가진다. 크기 조절 keyboard step은 기존과 같이 16px이다.

### 접근성·ARIA

Workspace strip은 `role="tablist"`와 `aria-orientation="vertical"`을 가진다. 각 workspace row는 `role="tab"`과 `aria-selected`를 제공하고, absolutePath tooltip은 `aria-describedby`로 연결한다. Filetree column은 활성 workspace tab에 연결된 `role="tabpanel"`이다. File tree가 multi-select 상태를 지원할 때 tree root는 `aria-multiselectable="true"`를 선언하고 각 row는 선택 상태를 `aria-selected`로 노출한다. Center의 editor·terminal·editor split pane은 각각 `role="region"`과 구체적인 `aria-label`을 가진다. diff tab root는 `role="region"`과 `aria-label="Diff: {path1} versus {path2}"`를 가진다. Context menu는 Radix/shadcn 기본 role을 따르며 `role="menu"`를 유지한다. 모든 split divider는 `role="separator"`와 방향별 `aria-orientation`을 선언한다.

### 아이콘 시스템

`lucide-react`를 기본 아이콘 시스템으로 채택한다. shadcn/ui 공식 선택이며 tree-shaking으로 30~50개 사용 시 ~15KB gzip이다. stroke-width는 1.75(Linear 값)로 확정하고 기본 16px·주요 chrome action 20px 이하로 구분한다. 고정 매핑: close=X·add=Plus·folder=Folder/FolderOpen·search=Search·git=GitBranch·terminal=SquareTerminal·command=Command·settings=Settings·chevron=ChevronRight/ChevronDown·split=SplitSquareHorizontal·maximize=Maximize2/Minimize2·diff=GitCompare. empty state: Wrench(tool)·History(session)·GitBranch(source control)·Eye(preview)·Search(search). 파일 타입 식별 아이콘은 `vscode-icons-js`(MIT, Vite `import.meta.glob` 기반 lazy SVG)를 사용한다. 기본 크기는 14px이며 §5-8의 workbench accent 동시 노출 가드를 따른다.

### Primitive 높이

Button h-8(32px)·Tab h-9(36px)·Checkbox 16px·Icon button 28px 확정.

### Empty state 구조

모든 패널 empty state는 통일된 4단 구조: 24px stroke icon(muted-foreground) + text-sm font-medium 제목(명사) + text-xs text-muted-foreground 1줄 설명 + 조건부 Button sm 또는 kbd 힌트.

패널별 문구: Workspace(FolderOpen,No workspace open,Open folder+Cmd+O)·Terminal(SquareTerminal,Open workspace to start terminal)·File tree(FolderOpen,No workspace selected,Open a workspace to browse files / Folder,No files,Create a file or folder in {workspace} to begin editing)·Tool(Wrench,Agent tool invocations appear here)·Session(History,No session history)·Source Control(GitBranch,No source changes)·Preview(Eye,Preview unavailable)·Search(Search,Search this workspace with Cmd+Shift+F).

"Coming soon" 문구는 금지하며, 미구현 패널은 기능 가치를 한 문장 서술한다. 일러스트는 사용하지 않는다. a11y 원칙: 아이콘은 aria-hidden, 제목이 스크린리더 앵커, 버튼 텍스트는 구체적이다.

### File tree interaction grammar

File tree는 VS Code interaction grammar를 MVP 기준으로 따른다. Toolbar actions는 New File / New Folder / Refresh / Collapse All을 제공하고, selected row는 focus 상태와 unfocus 상태를 분리해 표시한다. Inline create/rename, FileTreePanel 내부로 scope된 keyboard tree navigation, explicit delete confirmation은 유지한다. Multi-select는 `Cmd+click` 개별 toggle, `Shift+click` range, `Cmd+A` 현재 폴더 내 전체 선택, `Esc` 선택 해제를 지원한다. Context menu는 file/folder/empty 컨텍스트별 항목을 제공하며 파일 기준 13개 이상(Open, Open to the Side, Reveal in Finder, Open in Terminal, Find in Folder, Cut/Copy/Paste, Copy Path, Rename, Delete, Compare with Selected, Source Control 액션)을 노출한다. Drag-and-drop은 over/insert/invalid 세 상태, cross-pane open, Finder 외부 in/out, 같은 path 충돌 시 replace modal을 포함한다. 구현 기준은 react-arborist v3.5.0이며 22px 행 높이, depth당 8px indent, 1px indent guide, 1만+ 파일 가상화를 전제로 한다.

### Border·Spacing

Border 1px 고정. Focus ring만 2px 예외 허용. Spacing은 Tailwind 기본 4px 단위 유지.

### Command palette

MVP에 `cmdk` command palette를 포함한다. `Cmd+P`와 `Cmd+Shift+P`는 동일 팔레트다. 명령 그룹은 Workspace, View, Terminal, App이며 Preferences는 placeholder 명령이다. 파일 모드는 MVP command palette 범위에 포함되지 않는다.

### 단축키 맵

MVP 단일 레지스트리에 다음 단축키를 바인딩한다.

- `Cmd+O` — Workspace 열기.
- `Cmd+1/2/3` — 워크스페이스 탭 전환. 전환 후 Workspace strip의 active row를 `scrollIntoView({ block: "nearest" })`로 보정한다.
- `Cmd+W` — 활성 에디터 탭 닫기. 활성 에디터 탭이 없으면 활성 워크스페이스 닫기로 fallback한다.
- `Cmd+Shift+W` — 활성 워크스페이스 닫기.
- `Cmd+T` — 새 터미널 탭.
- `Cmd+Shift+[/]` — 이전/다음 탭.
- `Cmd+B` — Workspace strip + Filetree column 묶음 토글.
- `Cmd+J` — Shared panel 토글.
- `Cmd+\` — Editor split right toggle.
- `Cmd+Shift+M` — 현재 pane maximize toggle.
- `Cmd+Alt+←` / `Cmd+Alt+→` — 활성 탭을 다른 editor pane으로 이동.
- `Cmd+P` / `Cmd+Shift+P` — Command palette 열기.
- ``Ctrl+` `` — 터미널 포커스.
- `Cmd+Shift+F` — Shared panel의 Search 탭 열기 + input focus. Shared panel이 접혀 있으면 자동으로 펼친다.
- `Cmd+Shift+H` — Search 탭을 Replace mode로 열기.
- `Cmd+G` — Search 결과의 다음 match로 이동.
- `F2` — File tree 선택 항목 rename.
- `Del` — File tree 선택 항목 delete confirmation 열기.
- `Cmd+A` — File tree에서 현재 폴더 내 항목 전체 선택(recursive 아님).
- `Cmd+Enter` — Source Control inline commit 실행.
- `Cmd+Shift+Enter` — Source Control amend 실행.
- `Esc` — 팔레트·오버레이 닫기, Search 결과 dismiss, File tree multi-select clear.
- `j` — diff tab에서 다음 change로 이동.
- `k` — diff tab에서 이전 change로 이동.

Plan #31에서 추가·갱신된 shortcut 표면은 위 11개로 고정한다: `Cmd+Shift+F`, `Cmd+Shift+H`, `Cmd+G`, `F2`, `Del`, `Cmd+A`, `Cmd+Enter`, `Cmd+Shift+Enter`, `Esc`, `j`, `k`.

한국어 IME 조합 중 전역 단축키는 composition guard를 따라 전달을 차단한다.

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
8. **장식용 컬러 아이콘 금지** — 액션·상태·네비게이션 등 인터랙션과 의미 전달 아이콘은 모두 단색 stroke로 통일한다. 단, 파일 트리·에디터 탭·브레드크럼의 파일 타입 식별 아이콘은 정보 전달 목적으로 컬러를 허용한다. 컬러 아이콘 사용 시 (a) workbench accent(Terminal Teal)와 동시 노출 영역에서는 14px 이하를 유지하고, (b) hover/selection 배경 위 4.5:1 명도 대비를 보장하며, (c) 정보 전달 단일 목적을 벗어난 장식·강조·브랜딩 용도로 쓰지 않는다. stroke 두께 혼용 금지 원칙은 컬러 아이콘에도 적용한다.
9. **stroke 두께 2종 혼용** — 동일 맥락에서 서로 다른 stroke-width를 섞어 쓰는 것을 금지한다. 1.75 단일 값으로 통일하되, 아이콘 크기 차이는 stroke가 아니라 크기 토큰으로만 조정한다.

---

## 6. AI 터미널·국소 차별화 원칙

Warp 감성은 지역적 디테일로만 적용하고 block-based UI 전면 복제는 MVP 범위 초과이다.

### 세션 경계선

터미널 세션 구분은 subtle divider로 처리한다. 과장된 그림자나 색 대비 없이 1px border 토큰 수준에서 표현한다.

### 워크스페이스 상태 뱃지

첫 가시 UI 표면은 일반 탭 표식이 아니라 Workspace strip의 상태 뱃지다. 상태는 4상태 입력을 3개의 시각 출력으로 접는다. completed는 뱃지를 표시하지 않으며 mental model은 "끝났다=조용해졌다"로 고정한다. 뱃지는 텍스트 없는 static 8px dot이며 상태명은 sr-only 텍스트로 제공한다.

- **running** — `var(--color-status-running)` (차분한 녹)
- **awaiting-approval** — `var(--color-status-attention)` (절제된 amber)
- **error** — `var(--color-destructive)`
- **completed** — 뱃지 없음. "끝났다=조용해졌다" 모델을 따른다.

### tool 호출 하이라이트

하네스가 tool을 호출할 때 해당 터미널 영역에 subtle highlight를 적용한다. 전체 block 감싸기가 아닌, 터미널 내 텍스트 흐름을 해치지 않는 최소 범위의 배경색 변화만 허용.

### block-based terminal 전면 복제 금지

Warp의 block 기반 터미널 UI를 xterm.js 위에 별도 레이어로 재현하는 시도는 금지한다. 커스텀 렌더러나 DOM 오버레이 대규모 설계를 요구하며 MVP 범위를 명시적으로 초과한다. 차별화는 "경계선·뱃지·subtle highlight" 3요소로만 한정한다.
