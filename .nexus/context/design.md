---
doc: design-system-contract
version: "3.1"
status: active
token_source: src/shared/design-tokens/
theme_source: src/shared/design-tokens/theme-sources.ts
default_theme: github-dark
supersedes: design.md v3.0 (first-party warm/cool 테마 + chrome C ≤ 0.012 chroma 제약 — 외부 테마 도입으로 전면 대체)
design_basis: JetBrains "Islands" theme (2025) + VSCode/Atom/Sublime 인기 테마 도입 (v3.1)
---

# Nexus 디자인 시스템 계약 — Islands 모델

## §0. Preamble

이 문서는 Nexus 멀티테마 데스크톱 IDE의 **불변 디자인 철학과 토큰 구조 계약**이다.
색값(hex / oklch / rgba 리터럴)을 단 하나도 담지 않는다.
색값의 정본은 `src/shared/design-tokens/themes/*.ts`이며, 이 문서는 그 구조·규칙·철학의 선행 게이트다.

### v3 전환 배경

v2의 "Bounded Zones" 모델은 리전 경계를 **1px hairline + 서피스 레벨 차이**로 표현했다.
v3는 JetBrains의 Islands 테마(2025) 조사를 반영해 이를 **Islands 모델**로 대체한다:
UI는 단일 평면이 아니라, 통합 캔버스(backdrop) 위에 떠 있는 **독립된 둥근 "섬"들의 집합**이다.
경계는 선이 아니라 **명도 대비 + 물리적 갭 + 큰 라디우스**로 표현한다.

v2에서 유지되는 것: 무그림자 엘리베이션, near-monochromatic 저채도 톤, redundant interaction encoding,
3-tier 토큰 구조, semantic 토큰 vocabulary(§10), WCAG 대비 게이트.
v2에서 폐기되는 것: 섬 경계의 hairline 의존, "4단계 서피스 레벨(L0~L3)" 명명, 라디우스 4단계.

### 경로 참조 실재 검증 정책

이 문서 또는 토큰 파일 내 경로 참조를 수정할 때는 반드시 참조 대상 파일이 실재하는지 확인 후 반영한다.
존재하지 않는 파일을 참조하는 주석·front matter는 즉시 정정한다.

토큰 파일 분해 구조 (v3.1 — 어댑터 도입):

```
primitive.ts       원시값·불변 (스페이싱·라디우스·폰트)
semantic.ts        역할명 빈 키 계약, SemanticKey 타입 강제
theme-sources.ts   각 테마의 raw 색값 (ThemeSource 레코드 N개 — 외부 인기 테마 도입의 정본)
theme-adapter.ts   ThemeSource → SemanticTokenSet + EditorPalette 어댑터
themes/index.ts    THEME_SOURCES 순회 + buildSemanticTokens()로 THEMES 레지스트리 구축
component.ts       조립 + shadcn 어댑터 (buildShadcnVars)
index.ts           배럴 재export만
```

새 테마 추가 = `theme-sources.ts`에 ThemeSource 레코드 1개 추가 (그 외 모든 레지스트리는
자동 확장). 어댑터가 surface / state / git lane / terminal ANSI 매핑을 일괄 처리한다.

---

## §1. Philosophy — Islands 불변 5축

모든 테마가 반드시 준수해야 하는 불변(invariant) 원칙 5축.

### 1축: 공간 — Islands on a Canvas

UI는 연속된 단일 평면이 아니다. **통합 캔버스(backdrop)** 위에 **독립된 둥근 섬(island)** 들이 떠 있는 구조다.
각 콘텐츠 리전(에디터·사이드바·파일패널·터미널·하단패널)은 자율적인 섬이며, 자신만의 시각적 공간을 갖는다.
캔버스는 섬들을 받치는 프레임이고, titlebar·status bar·섬 사이 갭은 모두 이 캔버스에 속한다.

목적: 리전 간 시각적 자율성을 부여해 **집중 전환 피로를 줄인다**. 사용자는 "지금 어느 섬에 있는가"를
경계선을 읽지 않고 형태로 즉시 인지한다.

### 2축: 분리 — 색·선·그림자가 아닌 형태+공간+명도

섬과 섬의 경계는 다음 **세 신호의 동시 사용**으로만 표현한다:

1. **명도 대비** — 캔버스 배경과 섬 표면의 명도 차이
2. **물리적 갭** — 섬과 섬 사이에 캔버스가 노출되는 간격(§3 island gap)
3. **큰 라디우스** — 섬의 둥근 모서리(§4 island radius)가 섬을 독립된 "물체"로 만든다

섬 경계에 **hairline border를 긋지 않는다**. **그림자를 쓰지 않는다**. 색 단독에 의존하지 않는다.
이 다중 신호 원칙 덕분에 라이트/다크 어느 테마에서도, 색각 이상 사용자에게도 경계가 소실되지 않는다.

> hairline은 섬 *내부*의 미세 구획(리스트 행 구분선, 섹션 divider)에는 여전히 쓸 수 있다.
> 금지되는 것은 **섬 자체의 외곽 경계**를 hairline으로 표현하는 것이다.

### 3축: 엘리베이션 — 무그림자, 명도와 포커스 베일

입체감과 레이어 순서는 **그림자(box-shadow)가 아니라** 다음으로 표현한다:

- **명도 대비** — 위 계층일수록 캔버스와 더 큰 명도 차이
- **포커스 베일** — 포커스를 잃은 섬은 반투명 veil이 덧씌워져 흐려진다(§5). 활성 섬만 완전한 선명도를 갖는다.
- **scrim** — 모달(다이얼로그)은 backdrop scrim으로 하위 레이어를 차단한다

`--shadow-*: none`은 봉인(SEALED) 상수다. 어떤 레이어에도 drop shadow를 추가하지 않는다.

### 4축: 밀도 — 4px 베이스 그리드 + Islands 지오메트리

모든 간격은 **4px 베이스 그리드**(§3)를 따른다. 단 Islands 모델 고유의 고정 지오메트리
(island gap 6px, 컴팩트 4px / island radius 10px 등)는 그리드와 별개의 **불변 지오메트리 상수**다.
밀도는 두 단계(기본 / compact)로 운용하며, compact는 모든 갭·라디우스를 한 단계 축소한다.

### 5축: 톤 — 테마 자율 (v3.1 폐기)

v3.0의 "near-monochromatic 저채도 (C ≤ 0.012)" chrome 제약은 외부 인기 테마(Dracula,
Tokyo Night, Catppuccin 등)를 정본으로 도입하는 v3.1에서 폐기됐다. 이 제약은
first-party 테마가 정본이던 시기의 디자인 가이드였고, 외부 정체성 보존(Dracula의
보라/핑크, Tokyo Night의 청보라 등)과 양립하지 않는다.

대신 5축은 다음 두 가지로 압축된다:
- 순수 `#000` / `#fff` chrome 사용은 권장되지 않는다 (대비 게이트와 시각 피로 문제).
  단 외부 테마가 chrome에 흰색을 쓰는 경우 정체성 보존을 우선한다.
- 채도·hue·warmth는 **모두 테마 가변**. invariant 항목 아님.

### invariant ↔ theme-variant 경계선

| 속성 | invariant (모든 테마 공유) | theme-variant (테마별 가변) |
|---|---|---|
| 공간 모델 | Canvas + Islands 구조 | — |
| 분리 신호 | 명도+갭+라디우스 3신호 | 명도차의 구체 값 |
| 캔버스↔섬 명도 방향 | 다크=캔버스가 밝음 / 라이트=캔버스가 어두움 | 구체 명도값 |
| 스페이싱 | 4px 베이스 그리드 | — |
| Islands 지오메트리 | gap 6/4px, radius 10/8px 등 | — |
| 라디우스 | 5단계 명칭·역할 | — |
| 지오메트리 | 버튼 높이·titlebar 높이·탭 구조 | — |
| 타이포그래피 | 스케일 역할명·폰트 패밀리 목록 | — |
| 엘리베이션 방식 | 무그림자, 명도+베일 | 베일 불투명도 |
| 상태 신호 방식 | redundant encoding 필수 | 색 구현값 |
| 채도 정책 | — (v3.1 폐기, 외부 테마 정체성 보존 우선) | hue·chroma 자유 |
| semantic 색 | 역할명 (SemanticKey) | 토큰 채움값 |

---

## §2. Spatial Model — Canvas + Islands

### 3계층 공간 구조

v2의 L0~L3 4단계 서피스 레벨을 폐기하고, Islands 모델의 3계층으로 재정의한다.

| 계층 | 이름 | 리전 | 특성 |
|---|---|---|---|
| Backdrop | 캔버스 프레임 | titlebar, status bar, 섬 사이 갭 | 섬을 받치는 substrate. 한 장의 연속 표면 |
| Island | 섬 | 에디터, 사이드바/파일트리, 하단 패널, 터미널 | 둥근 사각형. 갭으로 분리. 캔버스와 명도 대비 |
| Floating | 부유 레이어 | 다이얼로그, 메뉴, 팝오버, 툴팁, 토스트, 커맨드 팔레트 | 모든 섬 위에 부유. 둥근 형태. scrim/대비로 분리 |

### Canvas↔Island 명도 관계 (불변 방향)

섬 분리의 1차 신호는 명도 대비다. 방향은 테마 명도에 따라 **반드시 다음을 따른다**:

- **다크 테마** — 캔버스가 섬보다 **밝다**. 섬(특히 에디터)이 캔버스 안으로 가라앉아 보인다.
- **라이트 테마** — 캔버스가 섬보다 **어둡다**. 섬이 캔버스 위로 떠올라 보인다.

캔버스↔섬 표면의 명도 대비는 **최소 1.20:1** 이상을 유지한다(JetBrains Islands 기준).
이 대비가 부족하면 갭과 라디우스가 있어도 섬 분리가 무너진다.

### 섬 구성 규칙

- 모든 섬은 `island` 라디우스(§4)의 둥근 사각형이다.
- 인접한 섬 사이에는 `island gap`(§3)만큼 캔버스가 노출된다.
- 섬의 외곽에는 border를 긋지 않는다. 섬은 표면색 + 라디우스 + 갭으로만 윤곽을 갖는다.
- titlebar와 status bar는 섬이 아니라 **캔버스(backdrop)** 의 일부다. 둥근 모서리·갭을 갖지 않는다.
- 섬 내부의 헤더·툴바·리스트 행 구분은 미세 명도차 또는 `surface.island.border` hairline으로 표현한다.

### Floating 레이어 가독성

Floating(다이얼로그·메뉴·팝오버·툴팁·커맨드 팔레트)은 **그림자가 아니라** 다음으로 전면 인식을 표현한다:

- `surface.floating.border` hairline — 주변과의 경계 명시 (Floating은 섬과 달리 외곽선을 가질 수 있다)
- Floating 표면이 캔버스·섬보다 높은 명도·채도 대비
- 모달의 경우 `surface.floating.scrim` backdrop scrim으로 하위 레이어 차단
- Floating 표면도 `island` 라디우스를 사용한다 (부유하는 섬)

---

## §3. Density — 4px 베이스 그리드 + Islands 지오메트리

### 스페이싱 스케일

모든 간격(padding / margin / gap)은 4px 베이스 그리드 위에서만 정의한다.

| 스텝 | px | 용도 |
|---|---|---|
| 2 | 2 | 미세 보정, 아이콘-텍스트 밀착 |
| 4 | 4 | 타이트 간격, compact island gap |
| 6 | 6 | **island gap (기본)** — Islands 고유 스텝 |
| 8 | 8 | 기본 컴포넌트 내부 패딩 |
| 10 | 10 | 보조 vertical padding — settings/sidebar 좁은 행 |
| 12 | 12 | 그룹 간 간격 |
| 16 | 16 | 섹션 패딩 |
| 24 | 24 | 큰 섹션 분리 |
| 32 | 32 | 레이아웃 블록 분리 |
| 48 | 48 | 최대 분리 |

실제 값 정본: `→ src/shared/design-tokens/primitive.ts`

규칙:
- 위 스케일에 없는 임의 px(5, 14, 15, 18px 등)는 in-app UI에 사용할 수 없다.
- `6`, `10`은 그리드에 정식 편입된 .5 스텝이다. `6`의 주 용도는 Islands gap,
  `10`은 settings/sidebar 의 좁은 vertical padding.
- IDE 컴포넌트 지오메트리(버튼 높이, titlebar 높이 등)는 아래 지오메트리 상수이며 스페이싱 토큰과 별도다.

### Islands 지오메트리 상수 (불변)

JetBrains Islands 조사값을 정본으로 한다. 기본 / compact 두 밀도를 운용한다.

| 상수 | 기본 | compact | 의미 | 사이클 |
|---|---|---|---|---|
| island gap | 6px | 4px | 인접한 섬 사이 캔버스 노출 간격 | v1 (이 사이클) |
| island radius | 10px | 8px | 섬·Floating 표면 모서리 (§4) | v1 (이 사이클) |
| 버튼 높이 | 28px | 24px | — | v2 (후속 사이클 — 매직 클래스 전수 치환 필요) |
| 버튼 최소 너비 | 72px | 72px | — | v2 (후속 사이클 — 매직 클래스 전수 치환 필요) |
| 입력 필드 높이 | 28px | 24px | — | v2 (후속 사이클 — 매직 클래스 전수 치환 필요) |

밀도 토글(기본 ⇄ compact)은 위 상수 세트를 일괄 전환한다. 개별 재정의는 금지한다.

v1은 `primitive.ts`의 `islandGeometry` 정본을 `generate-theme-css`가 `:root`와 `:root[data-density='compact']` 두 블록으로 emit하여 런타임에 토글한다. `controlH`는 매직 클래스 의존성 정리 후 v2에서 같은 cascade로 합류한다.

---

## §4. Shape — 라디우스 5단계

Islands 모델은 "둥근 물체로서의 섬"을 핵심 미감으로 한다. 라디우스는 5단계다.

| 단계 | 이름 | 값(px) | 적용 대상 |
|---|---|---|---|
| 0 | none | 0 | 전체 화면 영역, 라디우스가 부적절한 직각 경계 |
| 1 | control | 4 | 버튼, 입력 필드, 배지, 체크박스, 셀렉트 |
| 2 | raised | 6 | 인라인 배너, 작은 그룹 카드, 알림 블록 |
| 3 | island | 10 | **섬**(에디터·사이드바·패널·터미널) + Floating(다이얼로그·메뉴·팝오버) |
| 4 | full | 9999 | 진행 바, 아바타, pill |

실제 값 정본: `→ src/shared/design-tokens/primitive.ts`

규칙:
- 섬과 Floating 표면은 반드시 `island`(10px, compact 8px)를 쓴다.
- 라디우스 5단계 외의 값은 정의하지 않는다. `rounded-[Npx]` 매직넘버를 금지한다.
- 라디우스는 4px 베이스 그리드에 종속되지 않는 독립 스케일이다(`raised`=6, `island`=10).
- compact 밀도에서 `island`만 8px로 축소된다. control/raised/none/full은 밀도 불변이다.

> v2의 `--radius-control`(4) / `--radius-container`(8) 2단계는 폐기. `container`는 `island`로 승격(8→10).
> Tailwind v4에서 `rounded-[--radius-*]` 구문은 CSS를 생성하지 않으므로
> `rounded-(--radius-island)` 또는 `rounded-[var(--radius-island)]`만 사용한다.

---

## §5. Elevation — 무그림자 + 포커스 베일

### 무그림자 원칙

`--shadow-sm ~ --shadow-2xl`은 모두 `none`으로 봉인(SEALED, §9)된다.
어떤 레이어(섬·Floating 포함)에도 `box-shadow` 값을 지정하지 않는다.

### 레이어 순서 표현 수단

| 수단 | 적용 |
|---|---|
| 명도 대비 | Floating > 섬 > 캔버스 순으로 명도 대비를 키운다 |
| island gap | 섬 사이 물리적 간격이 분리를 보증한다 |
| scrim | 모달 다이얼로그는 `surface.floating.scrim`으로 하위 차단 |
| 포커스 베일 | 비활성 에디터 패널 섬을 흐리게 (아래) |

### 포커스 베일 (Inactive Veil)

포커스 베일은 **에디터 분할 패널 섬**에 적용된다. 활성 그룹 섬만 완전한 선명도를 갖고,
같은 에디터 영역의 비활성 패널 섬에는 반투명 veil(`surface.island.inactive.veil`)이 합성되어
흐려진다. 이것이 그림자 없이 "지금 활성 패널"을 표현하는 핵심 기법이다.

- 사이드바·파일 패널 섬은 **veil 예외** — 탐색용 크롬이므로 포커스와 무관하게 항상 선명하게 유지한다.
- 베일은 backdrop 색의 반투명 오버레이다 — 비활성 섬을 프레임 쪽으로 끌어당겨 가라앉힌다.
  backdrop 방향이므로 다크 테마는 밝은 방향, 라이트 테마는 어두운 방향으로 작동한다.
- 베일 불투명도는 theme-variant다. 과하면 비활성 섬이 읽히지 않고, 약하면 포커스 신호가 죽는다.
- 베일은 섬 단위로만 적용한다. 섬 내부 개별 컴포넌트에는 §8의 상태 토큰을 쓴다.

---

## §6. Typography — In-App 스케일

### 폰트 패밀리

| 역할 | 패밀리 |
|---|---|
| display / body / UI | Pretendard (Korean-first) |
| mono display / mono body | JetBrains Mono Nerd Font, Sarasa Term K 폴백 |

실제 family 문자열 정본: `→ src/shared/design-tokens/fonts.ts`

### In-App UI 타입스케일 (공식 소스)

| 역할 | fontSize | fontWeight | lineHeight | letterSpacing | 비고 |
|---|---|---|---|---|---|
| appBody | 13px | 400 | 1.4 | 0 | 기본 UI 텍스트 |
| appBodyEmphasis | 14px | 400 | 1.3 | 0 | 강조 본문 |
| appUiSm | 12px | 400 | 1.5 | 0 | 소형 sentence-case 텍스트 — 캡션·힌트·상태·에러 문구 |
| appMicro | 11px | 400 | 1.2 | 0 | 최소형 텍스트 — 툴팁, 보조 경로/메타데이터 힌트 |
| appLabel | 12px | 400 | 1.35 | 2.4px | 대문자 카테고리 레이블 **전용** — 반드시 uppercase 텍스트에만 |

실제 값 정본: `→ src/shared/design-tokens/index.ts` (`appTypeScale`)

In-app 텍스트 역할은 위 5개(`app*`) + 코드 2개(`code*`)가 전부인 **닫힌 집합**이다.
그 외 `text-*` 폰트 역할이 in-app 파일에 있으면 규약 위반이다.
크기 단계가 아니라 **의도**로 명명한다.

### 코드 타입스케일 (Monaco / xterm 전용)

| 역할 | fontSize | lineHeight | letterSpacing | 비고 |
|---|---|---|---|---|
| codeUi | 16px | 1.0 | 0 | 터미널 UI 요소 |
| codeBody | 16px | 1.0 | -0.2px | 코드 콘텐츠 |

실제 값 정본: `→ src/shared/design-tokens/index.ts` (`codeTypeScale`)

규칙:
- 마케팅 18-role 타입스케일은 in-app UI에 사용할 수 없다. 파이프라인(`generate-theme-css.ts`)에서 강제한다.
- in-app 스케일에 없는 크기는 신규 역할 추가로 해결하며 매직넘버(`text-[Npx]`)를 직접 쓰지 않는다.
- `appLabel`의 letterSpacing 2.4px는 역할의 일부다. 호출처가 `tracking-[…]`로 재지정하지 않는다.
- 사용자 가독성 설정(code/terminal 영역 한정)은 토큰 봉인의 명시적 예외 — 토큰 기본값은 미설정 시 fallback 역할만. UI 텍스트 역할(`app*`)에는 일절 전파 금지.

---

## §7. Motion

| 토큰 | 용도 |
|---|---|
| motion.fade | 요소 나타남·사라짐 전환 |
| motion.slide | 패널·서랍 슬라이드 |
| motion.scale | 팝오버·다이얼로그 진입 |

원칙:
- 에디터 콘텐츠 섬에서는 모션을 최소화한다 — 코딩 집중을 방해하지 않는다.
- `prefers-reduced-motion` 미디어 쿼리를 반드시 존중한다.
- 지속시간은 150~220ms 범위를 기본으로 한다. 정보 전달이 목적이며 연출이 목적이 아니다.
- 섬 포커스 전환(베일 on/off)은 `motion.fade`를 따른다.

실제 값 정본: `→ src/shared/design-tokens/semantic.ts`

---

## §8. Interaction — 9-State + Redundant Encoding

### 10개 인터랙션 상태

| 상태 | 설명 |
|---|---|
| default | 기본 유휴 상태 |
| hover | 포인터 진입 |
| active | 마우스 다운 / 탭 터치 |
| focus | 키보드 포커스 |
| selected | 선택됨 (탭, 트리 항목 등) |
| disabled | 비활성 |
| error | 유효성 검사 실패, 오류 |
| loading | 비동기 처리 중 |
| drag | 드래그 진행 중 — 드래그 소스 + 드롭 타깃 + 삽입 지점 표시 |
| empty | 콘텐츠 없음 — 전용 토큰 없음, `editor.text.muted` + `surface.*` 조립 |

### Redundant Encoding 원칙

상태는 **색 단독으로 전달해서는 안 된다.** 각 상태는 색 + 형태·서피스 변화 중 최소 2종을 동시 사용한다.

| 상태 | 색 | 형태·서피스 |
|---|---|---|
| hover | surface 미세 변화 | 배경 명도 상승 |
| active | surface 추가 변화 (hover보다 강함) | 배경 명도 추가 상승 또는 scale 축소 |
| focus | ring 색 표시 | 2px outline + offset, ring ≥ 3:1 대비 |
| selected | 강조색 | bold 또는 left indicator |
| error | error 토큰 색 | 아이콘 + border 변화 |
| disabled | opacity 감소 | pointer-events: none |
| loading | — | 인라인 스피너 (`state.loading.indicator`) |
| drag | 드롭 타깃 배경 강조 | 드래그 소스 opacity 감소 + 삽입선(`state.drag.indicator`) |

`success`는 컨트롤의 인터랙션 상태가 아니라 피드백 레이어다 — `feedback.success.*`로 분리(§10).

### 라이트 테마 오버레이 방향

다크 테마에서 hover/active 오버레이는 밝은 방향으로, 라이트 테마에서는 **어두운 방향**으로 반전된다.
rgba 흰색을 하드코딩하면 라이트 테마에서 hover가 소실된다.
오버레이는 반드시 `state.hover.bg`, `state.active.bg` semantic 토큰으로 참조한다.

### 색-의미 통제 예외 (Diff / Git Lane / Syntax)

다음은 **색이 본질적 의미**를 전달하는 통제된 예외로, redundant encoding 원칙의 예외를
허용한다. 단 보조 인코딩 또는 절제된 채도를 동반해야 한다:
- diff: 추가(녹색 계열) + `+` 기호 / 삭제(적색 계열) + `-` 기호
- git graph: commit 노드 = 원형, merge 노드 = 마름모
- syntax highlighting: 코드 토큰 변별을 위한 hue 사용 (§15). WCAG 본문 대비 4.5:1 유지.

(v3.0의 "C ≤ 0.012 chrome chroma 제약 예외"는 §1 5축에서 제약 자체가 폐기되어 더 이상
명시할 필요가 없다.)

---

## §9. Token Architecture — Primitive → Semantic → Component

### 3-Tier 구조

```
primitive.ts
  원시 색·스페이싱·라디우스·폰트 값. 테마가 직접 참조하지 않음

semantic.ts
  SemanticKey 타입 정의 (역할명 빈 키 계약)
  Record<SemanticKey, string> — 누락 시 TS2741 컴파일 에러. 값 없이 키만 정의

theme-sources.ts + theme-adapter.ts → themes/index.ts
  theme-sources.ts: 각 ThemeSource (raw 색값) 정본 — 외부 인기 테마 도입의 단일 소스
  theme-adapter.ts: ThemeSource → SemanticTokenSet 변환 (surface / state / git lane / ANSI 일괄 매핑)
  themes/index.ts: THEME_SOURCES 순회 + buildSemanticTokens()로 THEMES 레지스트리 구축

component.ts
  buildShadcnVars(tokens): Radix/shadcn CSS 변수 어댑터
  semantic → shadcn --변수명 매핑. SEALED 상수 포함
```

### SEALED 상수

테마가 변경할 수 없는 값. `component.ts`에 상수로 고정, `SemanticKey`에서 제외.

> SEALED = theme-invariant only. density override는 `:root[data-density]` cascade로 허용된다.

| 상수 | 값 | 의미 |
|---|---|---|
| --shadow-sm ~ --shadow-2xl | none | 무그림자 엘리베이션 |
| --radius-none | 0px | 라디우스 5단계 (§4) |
| --radius-control | 4px | |
| --radius-raised | 6px | |
| --radius-island | 10px | compact: 8px |
| --radius-full | 9999px | |

### 등록 테마 셋 (v3.1)

| 테마 ID | hue 방향 | base | 출처 |
|---|---|---|---|
| github-dark    | 청록·청보라 (저채도) | dark  | GitHub Primer (default-dark) — **기본값** |
| github-light   | 청·자홍 (라이트)     | light | GitHub Primer (light_default) |
| dracula        | 보라·핑크·노랑 (고채도) | dark  | dracula-theme.com |
| one-dark-pro   | 청록·올리브 (중채도) | dark  | Atom One Dark의 VSCode 포팅 |
| monokai        | 마젠타·시안·노랑 (고채도) | dark  | Sublime Text 클래식 |
| tokyo-night    | 청보라 (쿨톤)        | dark  | enkia/tokyo-night |
| solarized-dark | CIE 균일 팔레트       | dark  | Ethan Schoonover |
| nord           | 북유럽 블루 (16색)    | dark  | arcticicestudio/nord |
| catppuccin-mocha | 파스텔 (mocha flavor) | dark  | catppuccin/catppuccin |
| gruvbox-dark   | 따뜻한 머스타드·올리브 | dark  | morhetz/gruvbox |

OS Auto (system preference) 옵션은 v3.1에서 제거됐다 — 단일 light 변형만 존재하므로
dark↔light 자동 페어가 결정적이지 않다. 테마 선택은 항상 명시적이다.

새 테마 추가: `theme-sources.ts`에 ThemeSource 1건 추가하면 ThemeId union, THEMES
레지스트리, EDITOR_PALETTES, NEXUS_THEME_NAMES, terminal palette, settings UI 카드가
모두 자동 확장된다. 어댑터(theme-adapter.ts)가 surface / state / git lane / terminal ANSI
매핑을 일괄 처리한다.

---

## §10. Region Semantics — SemanticKey Vocabulary

토큰 명명 규칙: `<region>.<element>.<role>` 3세그먼트 flat 문자열 키.
`semantic.ts`의 `SemanticKey` freeze 기준이 된다.

> **v3 마이그레이션 주의**: 아래 "전역 Surface"는 Islands 모델에 맞춰 재정의되었다.
> v2의 `surface.canvas.*` / `surface.chrome.*` / `surface.panel.*`는 폐기되고
> `surface.backdrop.*` / `surface.island.*`로 대체된다. `semantic.ts`와 전 테마 파일의
> 동반 갱신이 필요하다(별도 후속 작업).

### 전역 Surface — Islands 3계층

| SemanticKey | 계층 | 설명 |
|---|---|---|
| surface.backdrop.bg | Backdrop | 캔버스 프레임 배경 — titlebar·status bar·섬 사이 갭 |
| surface.backdrop.fg | Backdrop | backdrop 위 텍스트 (titlebar 라벨 등) |
| surface.island.bg | Island | 섬 기본 표면 — 리전별 토큰의 베이스 |
| surface.island.fg | Island | 섬 위 기본 전경색 |
| surface.island.border | Island | 섬 *내부* 미세 구획 hairline (섬 외곽 경계용 아님) |
| surface.island.inactive.veil | Island | 비포커스 섬 dimming 오버레이 (§5 포커스 베일) |
| surface.floating.bg | Floating | 다이얼로그·메뉴·팝오버·툴팁 배경 |
| surface.floating.fg | Floating | floating 기본 전경색 |
| surface.floating.border | Floating | floating 외곽선 hairline |
| surface.floating.scrim | Floating | 모달 backdrop scrim 색 |

### 전역 State

인터랙션 상태 토큰. 리전 무관, 모든 컴포넌트가 공통 참조.

| SemanticKey | 설명 |
|---|---|
| state.hover.bg | hover 상태 배경 오버레이 (다크: 밝은 방향 / 라이트: 어두운 방향) |
| state.active.bg | active(마우스 다운) 상태 배경 오버레이 |
| state.selected.bg | selected 상태 배경 |
| state.selected.fg | selected 상태 전경색 |
| state.selected.indicator | selected 상태 좌측 indicator 색 |
| state.focus.ring | focus ring 색 (≥ 3:1 대비, 2px outline 필수) |
| state.disabled.fg | disabled 상태 전경색 |
| state.disabled.bg | disabled 상태 배경 |
| state.error.fg | error 상태 전경색 |
| state.error.border | error 상태 border 색 |
| state.error.bg | error 상태 배경 |
| state.warning.fg | warning 상태 전경색 |
| state.warning.border | warning 상태 border 색 |
| state.warning.bg | warning 상태 배경 |
| state.loading.indicator | 로딩 인디케이터 색 |
| state.drag.indicator | 드래그 삽입 지점 표시선 색 (탭 재배치, 트리 드롭 위치) |
| state.drop.target.bg | 유효 드롭 타깃 영역 강조 배경 |

### 전역 Scrollbar

스크롤바는 모든 스크롤 가능한 섬·Floating이 공통 참조한다. v2에서 `globals.css`가
primitive 토큰(`--color-mist-border` 등)으로 직접 칠하던 것을 semantic 토큰으로 승격한다.

| SemanticKey | 설명 |
|---|---|
| scrollbar.thumb.bg | 스크롤바 thumb 기본 색 (항상 표시 — 가상 스크롤 위치 신호) |
| scrollbar.thumb.hover.bg | thumb hover 시 색 (대비 상승) |
| scrollbar.track.bg | 스크롤바 track 색 (보통 투명 — 표면과 평평하게) |

### 전역 Feedback

성공·정보 피드백 레이어. 컨트롤 상태가 아니라 결과 알림 레이어이므로 `state.*`와 분리.

| SemanticKey | 설명 |
|---|---|
| feedback.success.fg / .border / .bg | 성공 피드백 |
| feedback.info.fg / .border / .bg | 정보 피드백 |

### IDE 리전 — 8개 섬/캔버스

각 콘텐츠 리전은 §2의 섬이다. titlebar·status는 캔버스(backdrop)에 속한다.

#### editor (에디터 섬)

| SemanticKey | 설명 |
|---|---|
| editor.text.default | 기본 코드 텍스트 |
| editor.text.muted | 주석, 비활성 토큰 |
| editor.gutter.bg | 줄 번호 영역 배경 |
| editor.gutter.fg | 줄 번호 색 |
| editor.line.highlight | 현재 줄 하이라이트 배경 |
| editor.selection.bg | 텍스트 선택 배경 |
| editor.cursor.color | 커서 색 |
| editor.find.highlight | 검색 일치 하이라이트 |
| editor.indent.guide | 들여쓰기 가이드라인 |

> 위는 에디터 섬의 SemanticKey 일부다. 코드 **구문 강조(syntax)** 와 selection/find/peek/widget/
> diagnostic 등 **에디터 chrome 전체 팔레트**는 §15 Code Editor Theming이 별도 계약으로 다룬다.

#### sidebar (사이드바 / 파일트리 섬)

| SemanticKey | 설명 |
|---|---|
| sidebar.bg | 사이드바 섬 배경 |
| sidebar.fg | 사이드바 기본 텍스트 |
| sidebar.item.hover.bg | 항목 hover 배경 |
| sidebar.item.selected.bg | 선택 항목 배경 |
| sidebar.item.selected.fg | 선택 항목 텍스트 |
| sidebar.item.indicator | 선택 항목 좌측 indicator |
| sidebar.icon.fg | 파일 트리 아이콘 기본색 |
| sidebar.badge.bg | 배지 배경 |
| sidebar.badge.fg | 배지 텍스트 |

#### tab (탭바)

| SemanticKey | 설명 |
|---|---|
| tab.bar.bg | 탭바 배경 |
| tab.active.bg | 활성 탭 배경 |
| tab.active.fg | 활성 탭 텍스트 |
| tab.active.border | 활성 탭 강조선 |
| tab.inactive.bg | 비활성 탭 배경 |
| tab.inactive.fg | 비활성 탭 텍스트 |
| tab.hover.bg | 탭 hover 배경 |
| tab.modified.dot | 수정됨 표시 점 색 |

#### panel (하단 패널 섬)

| SemanticKey | 설명 |
|---|---|
| panel.bg | 하단 패널 배경 |
| panel.fg | 패널 기본 텍스트 |
| panel.header.bg | 패널 헤더 배경 |
| panel.header.fg | 패널 헤더 텍스트 |
| panel.tab.active.fg | 패널 활성 탭 텍스트 |
| panel.tab.inactive.fg | 패널 비활성 탭 텍스트 |
| panel.border | 패널 내부 구획 hairline |

#### terminal (터미널 섬)

| SemanticKey | 설명 |
|---|---|
| terminal.bg | 터미널 배경 (xterm background API 용) |
| terminal.fg | 터미널 기본 전경색 |
| terminal.cursor.color | 터미널 커서 색 |
| terminal.cursor.accent | 커서 블록 내부 텍스트 색 |
| terminal.selection.bg | 선택 배경 |

#### diff (diff 뷰어)

| SemanticKey | 설명 |
|---|---|
| diff.added.bg / .fg / .gutter | 추가 라인 |
| diff.deleted.bg / .fg / .gutter | 삭제 라인 |
| diff.modified.bg | 수정 라인 배경 |
| diff.unchanged.fg | 미변경 라인 텍스트 (muted) |

#### git (git 패널 / 그래프)

| SemanticKey | 설명 |
|---|---|
| git.lane.0 ~ git.lane.7 | 그래프 lane 8색 (색-구분 예외, 형태 보조 인코딩 필수) |
| git.node.commit.fill | commit 노드 (원형) 채움색 |
| git.node.merge.fill | merge 노드 (마름모) 채움색 |
| git.node.tag.fill | 태그 노드 채움색 |
| git.label.branch.bg / .fg | 브랜치 레이블 |
| git.label.remote.bg / .fg | 원격 레이블 |
| git.status.added.fg | Staged/Added 상태 텍스트 |
| git.status.modified.fg | Modified 상태 텍스트 |
| git.status.deleted.fg | Deleted 상태 텍스트 |
| git.status.untracked.fg | Untracked 상태 텍스트 |
| git.status.conflict.fg | Conflict 상태 텍스트 |

#### status (상태바 — 캔버스 소속)

| SemanticKey | 설명 |
|---|---|
| status.bar.bg | 상태바 배경 (backdrop과 동조) |
| status.bar.fg | 상태바 기본 텍스트 |
| status.bar.item.hover.bg | 상태바 항목 hover 배경 |
| status.bar.error.bg / .fg | 오류 강조 |
| status.bar.warning.bg / .fg | 경고 강조 |

### terminal.ansi.* 16키

ANSI 16색 팔레트. xterm `ITheme` 타입과 1:1 대응.
`Record<ThemeId, ITheme>`는 `src/shared/design-tokens/themes/terminal-palette.ts`에서 관리.
black/red/green/yellow/blue/magenta/cyan/white + bright 8색.

---

## §11. Theme Authoring Rules

### WCAG 대비 게이트 (필수)

| 항목 | 최소 대비비 | 기준 |
|---|---|---|
| 본문 텍스트 (appBody, appBodyEmphasis) | 4.5:1 | WCAG 2.2 §1.4.3 |
| 대형 텍스트 (18px Bold / 24px Regular 이상) | 3:1 | WCAG 2.2 §1.4.3 |
| UI 컴포넌트 경계·상태 표시 | 3:1 | WCAG 2.2 §1.4.11 |
| 포커스 링 | 3:1 이상 + 최소 2px | WCAG 2.2 §2.4.11 |
| **캔버스↔섬 표면 명도 대비** | **1.20:1** | Islands 분리 신호 (§2) |
| 색 단독 정보 전달 | 금지 | WCAG 2.2 §1.4.1 |

muted 텍스트(11~13px) 구간이 최고 위험 구간이다. appUiSm / appMicro / appLabel은 배경 대비 4.5:1 이상.

### Islands 모델 게이트

- 캔버스↔섬 명도 방향이 §2 불변 규칙을 따르는가 (다크=캔버스 밝음 / 라이트=캔버스 어두움)
- 섬 외곽을 hairline·그림자로 표현하지 않았는가
- 포커스 베일(`surface.island.inactive.veil`)이 비활성 섬을 읽히지 않게 만들 만큼 과하지 않은가
- 섬 분리가 색뿐 아니라 갭+라디우스로도 보증되는가

### 라이트 테마 추가 규칙

- hover / active 오버레이는 어두운 방향으로 구현한다.
- 흰색 rgba 오버레이는 라이트 테마에 사용할 수 없다.
- 포커스 베일은 backdrop(어두운 프레임) 방향으로 구현한다 — 라이트 테마에서 비활성 섬은 어두워진다.
- 캔버스가 섬보다 어둡다는 §2 방향을 반드시 지킨다.

### SemanticKey 충족 게이트

`semantic.ts`의 `Record<SemanticKey, string>` 타입이 컴파일 타임에 누락을 TS2741로 검출한다.

### 테마 적용 방식

빌드타임에 모든 테마 CSS 생성, 런타임은 `documentElement`의 `data-theme` 속성만 변경.
FOUC 방지를 위해 `index.html <head>` 인라인 부트 스크립트가 `localStorage`에서 themePreference를 동기 읽기.
영속화: `localStorage`(부트 캐시) + `appState`(정본) 이중 기록.

---

## §12. Anti-patterns

발견되면 즉시 수정해야 하는 금지 패턴이다.

| 패턴 | 이유 | 대안 |
|---|---|---|
| 섬 외곽 경계를 hairline border로 표현 | Islands 분리 신호 위반 | 명도 대비 + island gap + island radius |
| 섬·Floating에 `box-shadow` 추가 | 무그림자 엘리베이션 위반 | 명도 대비 + 포커스 베일 + scrim |
| 색값(hex/oklch/rgba) 하드코딩 | 테마 전환 불가, 드리프트 | semantic 토큰 참조 |
| `rounded-[--radius-*]` (Tailwind v3 구문) | v4에서 CSS 미생성 (silent no-op) | `rounded-(--radius-island)` |
| `rgba(255,255,255,…)` 오버레이 — 라이트 테마 | hover·베일 소실 | `state.*` / `surface.island.inactive.veil` 토큰 |
| 상태를 색 단독 신호 | 색각 이상 접근성 위반 | redundant encoding (§8) |
| 캔버스↔섬 명도 방향 위반 | 섬이 떠 보이지 않거나 가라앉지 않음 | §2 불변 방향 |
| 마케팅 타입스케일 in-app 사용 | 밀도 철학 위반 | appTypeScale (§6) |
| 그리드 외 스페이싱(5, 10, 14, 15px 등) | 4px 그리드 위반 | §3 스페이싱 스케일 |
| 라디우스 5단계 외 값 / `rounded-[Npx]` | 형태 일관성 파괴 | none/control/raised/island/full |
| 임의 크기 매직넘버 (`w-[420px]` 등 반복) | 토큰 부재, 드리프트 | 공용 크기 토큰 정의 후 참조 |
| SemanticKey 미포함 토큰 직접 사용 | vocabulary 외부 확장 불가 | semantic.ts에 키 추가 후 사용 |
| design.md에 색값 기록 | 드리프트 보장, 자기모순 | themes/*.ts에만 색값 |
| 순수 #000 / #fff 사용 | 톤 불변 원칙 위반 | hue 틴트된 뉴트럴 |
| 존재하지 않는 파일 경로 참조 | 오참조 혼란 | 실재 확인 후 참조 |
| 신택스 색을 Monaco 기본 테마에 상속 (`rules: []`) | 코드만 다른 디자인 언어로 칠해짐 | §15 syntax 토큰 작성 |
| 아이콘 크기 12/16px 외 값 사용 | 아이콘 그리드 위반 | §14 sm(12) / md(16) 2종 |
| 아이콘 `strokeWidth` 개별 재정의 | 아이콘 굵기 불일치 | lucide 기본 1.5 유지 |
| 스크롤바를 primitive 토큰으로 직접 칠 | semantic 계층 우회 | `scrollbar.*` 토큰 (§10) |
| `palette.ts` 외 파일에서 에디터 색 hex 사용 | Monaco 변환 경계 위반 | `palette.ts`에만 (§15.3) |
| 사용자 폰트 override를 UI 텍스트(`app*`)에 전파 | §6 봉인 정신 위반 | code/terminal 영역에만 적용 |

---

## §13. Agent Guide

이 문서를 참조해 코드를 작성하는 LLM 에이전트를 위한 가이드.

### 토큰 참조 순서

1. `semantic.ts`에서 SemanticKey 존재 여부 확인
2. 없으면 semantic.ts에 키 추가(vocabulary 확장), 기존 테마 파일 전부 업데이트
3. 컴포넌트는 CSS 변수(`var(--<key>)`)로 참조, 색값 하드코딩 금지
4. 새 테마 파일 추가 시 모든 SemanticKey 충족 후 빌드 확인

### 섬(Island) 구현 체크리스트

- [ ] 섬 표면은 `surface.island.bg` 또는 리전별 토큰(`editor.*`/`sidebar.*` 등)
- [ ] 섬 모서리는 `island` 라디우스 (`rounded-(--radius-island)`)
- [ ] 인접 섬과의 간격은 island gap(6px, compact 4px) — 캔버스가 노출되어야 함
- [ ] 섬 외곽에 border / box-shadow 금지
- [ ] 비활성 섬은 `surface.island.inactive.veil`로 dimming
- [ ] titlebar·status bar는 섬이 아님 — `surface.backdrop.*` / `status.bar.*`, 둥근 모서리 없음

### 상태 구현 체크리스트

- [ ] hover: `state.hover.bg` + 서피스 명도 변화
- [ ] active: `state.active.bg` + hover보다 강한 변화 또는 scale 축소
- [ ] focus: `state.focus.ring` + 2px outline + offset
- [ ] selected: 강조색 + 좌측 indicator 또는 font-weight 변화
- [ ] error: error 토큰 색 + 아이콘 + border 변화
- [ ] disabled: opacity 감소 + pointer-events none
- [ ] loading: `state.loading.indicator` 스피너 + 텍스트 레이블

### 에디터·아이콘 체크리스트

- [ ] 아이콘 크기는 `size-3`(12px) 또는 `size-4`(16px)만 — §14
- [ ] 아이콘 색은 `currentColor` 상속, 강조 시에만 `*.icon.fg` 토큰
- [ ] 신택스 토큰은 `syntax.*` 역할로 참조 — Monaco `rules` 채움 (§15.1)
- [ ] 에디터 chrome 색은 `EditorPalette` 인터페이스로만 — `palette.ts` 정본 (§15.2)
- [ ] 스크롤바는 `scrollbar.*` semantic 토큰 사용

### 금지 사항 요약

- 섬 경계를 hairline·그림자로 표현 금지
- 색값 하드코딩 금지 (`palette.ts` Monaco hex는 §15.3 명시 예외)
- `rounded-[--radius-*]` (v3 구문) 금지 — `rounded-(--radius-*)` 사용
- 마케팅 타입스케일 in-app 사용 금지
- 그리드 외 스페이싱 금지
- 라디우스 5단계 외 값 금지
- 아이콘 크기 12/16px 외 값·`strokeWidth` 재정의 금지
- 오버레이에 `rgba(255,255,255,…)` 하드코딩 금지
- design.md에 색값 추가 금지 — `→ src/shared/design-tokens/themes/*.ts`에만

---

## §14. Iconography

### 아이콘 라이브러리

in-app 아이콘은 `lucide-react` 단일 소스를 쓴다. 다른 아이콘 라이브러리·인라인 SVG·아이콘 폰트를
혼용하지 않는다. 아이콘 자산을 별도로 리컬러링하지 않는다 (JetBrains의 SVG `ColorPalette` 리매핑과
달리, lucide는 `currentColor` 상속이므로 색 계층이 단순하다).

### 크기 그리드 — 2단계 닫힌 집합

| 단계 | px | Tailwind | 용도 |
|---|---|---|---|
| sm | 12 | `size-3` | 조밀 UI — 파일트리 행, 상태바, 인라인 아이콘 |
| md | 16 | `size-4` | 기본 — 툴바, 버튼, 탭, 패널 헤더 |

- 이 2종이 in-app 아이콘 크기의 **닫힌 집합**이다. 그 외 `size-N`을 아이콘에 쓰지 않는다.
- 더 큰 그래픽(빈 상태 일러스트 등)은 아이콘이 아니며 이 그리드에 종속되지 않는다.

### 색

- 아이콘은 기본적으로 `currentColor`를 상속한다 — 부모 텍스트 색을 그대로 따른다.
- 리전별 고정 강조가 필요할 때만 §10의 `*.icon.fg` 토큰(`sidebar.icon.fg` 등)을 쓴다.
- hover/disabled 등 상태는 텍스트와 동일하게 §8 상태 처리를 따른다 — 아이콘 전용 상태 색을 만들지 않는다.

### 스트로크

- lucide 기본 `strokeWidth` 1.5를 유지한다. 개별 아이콘에서 재정의하지 않는다 (굵기 일관성).

### 의미 인코딩

- 아이콘 단독으로 상태·의미를 전달하지 않는다 (§8 redundant encoding) — 텍스트 레이블 또는
  `aria-label`을 동반한다.

---

## §15. Code Editor Theming

Monaco 에디터는 UI chrome과 색 요구가 다르다 — 코드 가독성을 위해 변별 가능한 hue가 필요하다.
따라서 별도 토큰 계층으로 다루되, **이 계약의 일부다.** v2까지 에디터 색은 design.md 바깥
(`src/shared/editor/palette.ts` + Monaco 기본 테마)에 방치되어 있었고, v3는 이를 계약 안으로 흡수한다.

### §15.1 Syntax Highlighting — 토큰 역할

코드 구문 강조는 **Nexus 팔레트로 직접 작성한다.** Monaco 기본 `vs` / `vs-dark` 테마 상속
(`rules: []`)은 폐기한다 — 에디터 코드만 다른 디자인 언어로 칠해지는 것을 막는다.

신택스 토큰 역할(닫힌 집합):

| 역할 | 대상 |
|---|---|
| syntax.keyword | 키워드·제어 흐름 (if / return / const / import) |
| syntax.string | 문자열 리터럴 |
| syntax.number | 숫자·불리언 리터럴 |
| syntax.comment | 주석 |
| syntax.function | 함수·메서드 이름 |
| syntax.type | 타입·클래스·인터페이스 이름 |
| syntax.variable | 변수·식별자 |
| syntax.constant | 상수·enum 멤버·내장 상수 |
| syntax.property | 객체 속성·필드 키 |
| syntax.operator | 연산자·구두점 |
| syntax.tag | 마크업 태그 (JSX / HTML) |
| syntax.attribute | 마크업 속성명 |
| syntax.namespace | 모듈·네임스페이스 |
| syntax.regexp | 정규식·이스케이프 시퀀스 |
| syntax.invalid | 오류·deprecated 토큰 |

채도 정책: 신택스 토큰은 §8 "색-의미 통제 예외"에 속하며 hue·채도 모두 외부 테마의 정본을
존중한다. 단 WCAG 본문 대비 4.5:1은 유지해야 한다 — 외부 테마가 이를 미달하면 도입 단계에서
조정한다(현재 등록 10개 테마는 모두 충족).

발현 경로 (현행):
- **LSP capable 언어 (TS/JS/Python 등)** — `textDocument/semanticTokens/full`을 통해
  서버가 토큰을 산출하고, 클라이언트가 canonical 24-슬롯 legend로 remap하여 Monaco의
  `registerDocumentSemanticTokensProvider`로 흘려보낸다. `syntax.function` /
  `syntax.property` / `syntax.variable` / `syntax.parameter` 등 Monarch만으로는 변별이
  제한적이었던 역할도 LSP가 붙은 파일에서는 정상 발현된다.
- **비-LSP 언어 또는 서버가 capability 미지원** — Monarch fallback. Monarch가
  `identifier` 하나로 묶어 내보내는 토큰은 `syntax.variable`로 통일된다. 이는 fallback
  동작이며 의도된 동작이다 (semantic-tokens.ts의 `unknown` sentinel slot이 이 경로를
  보장 — delta-chain은 무손상으로 유지된다).

관련 와이어링:
- `src/shared/lsp/client-capabilities.ts` — semanticTokens capability 광고 (full mode)
- `src/shared/lsp/semantic-tokens.ts` — canonical 24-슬롯 legend + remap 함수
- `src/main/features/lsp/agent-host.ts` `semanticTokensByUri()` — 서버별 legend → canonical remap
- `src/renderer/services/editor/lsp/providers.ts` — Monaco provider 등록
- `src/renderer/services/editor/runtime/monaco-theme.ts` `buildSyntaxRules()` — LSP legend
  토큰 타입(property/method/parameter/modifier/macro/event/decorator/label)을 §15.1
  15역할로 폴딩 매핑

향후 결 다듬기 (선택 사항):
- Token modifier 활용 — 현재 modifier bitmask는 패스스루만 한다.
  `readonly` / `deprecated` / `defaultLibrary` 등을 fontStyle (italic/underline) 또는
  opacity 차등으로 표현하려면 `buildSyntaxRules`에 dotted form rule
  (예: `token: "variable.readonly"`) 추가 + 팔레트에 modifier 변형 색을 정의한다.

### §15.2 Editor Chrome — EditorPalette

selection / find·match / peek / widget surface / link / diagnostic 등 에디터 chrome 색은
`EditorPalette` 인터페이스(`→ src/shared/editor/palette.ts`)가 정본 계약이다.
이는 `SemanticTokenSet`과 병렬인 typed token set이며, `Record<ThemeId, EditorPalette>`로
모든 테마가 충족한다 — 누락 시 컴파일 에러로 검출된다(`terminal.ansi.*` 16키와 동일한 거버넌스).

신택스 토큰(`syntax.*`)과 chrome 토큰(`EditorPalette`) 모두 themes 계층의 정식 산출물이며,
design.md 바깥의 "비공식 색"이 아니다.

### §15.3 Monaco hex 변환 경계 (§0 예외)

Monaco의 standalone 테마 파서는 `rgba()` / `oklch()` / named-color를 거부하고 hex만 받는다
(거부 시 `#ff0000` sentinel로 폴백). 따라서 `palette.ts`는 8-digit hex 리터럴을 담는다.
이는 §0 "색값 하드코딩 금지"의 **기술적으로 불가피한 명시적 예외**다. 단 다음을 강제한다:

- hex 값은 `themes/*.ts`의 OKLCH / rgba 정본에서 **파생**되어야 하며 독립 표류 금지.
- 파생 관계(원본 OKLCH·alpha 값)를 주석으로 명시한다 — 현행 `palette.ts` 관행을 계약으로 승격.
- `palette.ts` **외의 어떤 파일에서도** 에디터 색을 hex로 직접 쓰지 않는다.
- 이 예외는 Monaco 테마 정의에만 적용된다. 그 외 모든 곳은 §0·§12 원칙을 그대로 따른다.
