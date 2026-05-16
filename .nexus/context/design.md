---
doc: design-system-contract
version: "2.0"
status: active
token_source: src/shared/design-tokens/
theme_source: src/shared/design-tokens/themes/
default_theme: warm-dark
supersedes: design.md v1 (Warp 마케팅 사이트 분석본, 전면 폐기)
---

# Nexus 디자인 시스템 계약

## §0. Preamble

이 문서는 Nexus 멀티테마 데스크톱 IDE의 **불변 디자인 철학과 토큰 구조 계약**이다.
색값(hex / oklch / rgba 리터럴)을 단 하나도 담지 않는다.
색값의 정본은 `src/shared/design-tokens/themes/*.ts`이며, 이 문서는 그 구조·규칙·철학의 선행 게이트다.

### 경로 참조 실재 검증 정책

이 문서 또는 토큰 파일 내 경로 참조를 수정할 때는 반드시 참조 대상 파일이 실재하는지 확인 후 반영한다.
존재하지 않는 파일을 참조하는 주석·front matter는 즉시 정정한다.
(현 `index.ts`의 `./design-tokens-marketing.ts` 오참조가 이 정책의 기원이다.)

토큰 4파일 분해 구조:

```
primitive.ts       원시값·불변
semantic.ts        역할명 빈 키 계약, SemanticKey 타입 강제
themes/*.ts        전 SemanticKey 충족 (warm-dark, cool-dark, warm-light …)
component.ts       조립 + shadcn 어댑터 (buildShadcnVars)
index.ts           배럴 재export만
```

---

## §1. Philosophy — 불변 5축

모든 테마가 반드시 준수해야 하는 불변(invariant) 원칙 5축.

### 불변 5축

**1축: 공간 모델 — Bounded Zones**
에디터 캔버스·chrome·패널·floating 리전은 4단계 서피스 레벨(L0~L3)로 경계를 표현한다.
존 경계는 미세 라디우스 + 서피스 레벨 차이 + 1px hairline으로 표현하며, 색에만 의존하지 않는다.

**2축: 밀도 — 순수 4pt 그리드**
모든 간격·크기·정렬은 4의 배수(2, 4, 8, 12, 16, 24, 32, 48px)로만 정의한다.
마케팅 역산 잔재(5, 10, 14, 15, 18, 26, 30px)는 in-app 레이어에 존재할 수 없다.

**3축: 형태 — 라디우스 4단계**
`none(0) / control(4) / container(8) / full`의 네 단계만 허용한다.
그 외 값은 정의하지 않는다.

**4축: 인터랙션 — redundant encoding**
상태(hover / active / focus / selected / disabled / error / loading / empty)는 **색 단독 신호 금지**.
색 + 형태 변화(border width, outline, opacity shift) + 서피스 변화 중 최소 2종을 동시 제공한다.
success는 컨트롤의 인터랙션 상태가 아닌 피드백 레이어다 — `feedback.success.*` 토큰으로 분리하며 §9 전역 Feedback 참조.

**5축: 톤 — warmth는 불변이 아니다**
warmth는 "Warm Dark" 기본 테마의 hue 선택으로 강등된다. 불변으로 승격되는 것은 추상 원칙뿐:
- 뉴트럴 계열은 브랜드 hue로 미세 틴트
- 채도 C ≤ 0.012 (near-monochromatic 저채도)
- 순수 #000 / #fff 금지
- 엘리베이션은 그림자보다 톤·보더 우선 (그림자 없는 엘리베이션)

### invariant ↔ theme-variant 경계선

| 속성 | invariant (모든 테마 공유) | theme-variant (테마별 가변) |
|---|---|---|
| 서피스 레벨 구조 | L0~L3 4단계, 레벨 의미 | 각 레벨의 구체적 색값 |
| 스페이싱 | 4pt 그리드 8단계 | — |
| 라디우스 | 4단계 명칭·역할 | — |
| 지오메트리 | 버튼 높이·titlebar 36px·탭 구조 | — |
| 타이포그래피 | 스케일 역할명·폰트 패밀리 목록 | — |
| 상태 신호 방식 | redundant encoding 필수 | 색 구현값 |
| 채도 정책 | C ≤ 0.012, 순흑백 금지 | hue 방향 (warm/cool/neutral) |
| 존 경계 표현 | 형태 기반 (hairline + 레벨차) | hairline 색값 |
| 엘리베이션 방식 | 톤·보더 우선, 그림자 없음 | — |
| warmth 구체값 | — | 테마별 hue, accent 색 |
| semantic 색 | 역할명 (SemanticKey) | 토큰 채움값 |

---

## §2. Spatial Model — 4 Surface Level + Bounded Zones

### Surface Level

| 레벨 | 이름 | 리전 | 특성 |
|---|---|---|---|
| L0 | Canvas | 에디터 캔버스, 터미널 콘텐츠 영역 | 가장 낮은 명도 또는 순수 배경 |
| L1 | Chrome | titlebar, sidebar chrome, 상태바 | L0보다 살짝 높은 서피스, 앱 쉘 |
| L2 | Panel / Tab | 파일트리·git·검색 패널, 탭바 | L1과 동조 또는 L1+1 단계 |
| L3 | Floating | 다이얼로그, 메뉴, 팝오버, 툴팁, 토스트 | 가장 높은 서피스, 항상 전면 |

### Bounded Zones 원칙

- 리전 경계는 서피스 레벨 차이 + 1px hairline의 조합으로만 표현한다.
- hairline은 `surface.*.border` semantic 토큰으로 참조하며 색값을 하드코딩하지 않는다.
- titlebar ↔ sidebar, split-pane 사이에는 P3 존경계 hairline이 필수다.
- 색만 바뀌어도 경계가 소실되어서는 안 된다 (라이트 테마 붕괴 방지).

### L3 Floating legibility

L3(팝오버·다이얼로그·메뉴·툴팁)의 입체감과 전면 인식은 **그림자가 아니라** 다음 수단으로 표현한다:
- `surface.floating.border` hairline — 주변 서피스와의 경계 명시
- L3 서피스 레벨이 L2보다 높은 명도·채도 대비
- 모달(다이얼로그)의 경우 `surface.floating.scrim` backdrop scrim으로 하위 레이어 차단

`--shadow-*: none` SEALED 상수는 L3에도 동일하게 적용된다. drop shadow를 추가하지 않는다.

---

## §3. Density — 4pt Grid

### 공식 스페이싱 8단계

| 토큰 | px |
|---|---|
| space-1 | 2 |
| space-2 | 4 |
| space-3 | 8 |
| space-4 | 12 |
| space-5 | 16 |
| space-6 | 24 |
| space-7 | 32 |
| space-8 | 48 |

실제 값 정본: `→ src/shared/design-tokens/primitive.ts`

규칙:
- 이 표에 없는 간격(5, 10, 14, 15, 18, 26, 30px 등)은 in-app UI에 사용할 수 없다.
- IDE 컴포넌트 지오메트리(버튼 높이, titlebar 36px 등)는 고정값이며 스페이싱 토큰과 별도다.

---

## §4. Shape — 라디우스 4단계

| 단계 | 이름 | 값(px) | 적용 대상 |
|---|---|---|---|
| 0 | none | 0 | 분리된 팬 경계, 전체 화면 영역 |
| 1 | control | 4 | 버튼, 입력 필드, 배지, 체크박스 |
| 2 | container | 8 | 카드, 패널, 팝오버, 다이얼로그 |
| 3 | full | 9999 | 진행 바, 아바타, 전용 pill |

실제 값 정본: `→ src/shared/design-tokens/primitive.ts`

봉인 해제 근거: 기존 `--radius: 0` 전면 봉인은 LLM이 추가한 flat-design 산물이다.
Bounded Zones가 container 라디우스를 요구하므로 해제하고 4단계 체계로 재정의한다.
`--shadow-*: none`은 봉인이 아니라 **그림자 없는 엘리베이션 철학**의 표현이며 유지한다.

---

## §5. Typography — In-App 스케일

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
| appUiSm | 12px | 400 | 1.5 | 0 | 소형 레이블 |
| appUiXs | 12px | 400 | 1.35 | 2.4px | 대문자 카테고리 레이블 |

실제 값 정본: `→ src/shared/design-tokens/index.ts` (`appTypeScale`)

### 코드 타입스케일 (Monaco / xterm 전용)

| 역할 | fontSize | lineHeight | letterSpacing | 비고 |
|---|---|---|---|---|
| codeUi | 16px | 1.0 | 0 | 터미널 UI 요소 |
| codeBody | 16px | 1.0 | -0.2px | 코드 콘텐츠 |

실제 값 정본: `→ src/shared/design-tokens/index.ts` (`codeTypeScale`)

규칙:
- 마케팅 18-role 타입스케일(80px display hero 등)은 in-app UI에 사용할 수 없다.
- in-app 스케일에 없는 크기는 신규 역할 추가로 해결하며 매직넘버를 직접 사용하지 않는다.

---

## §6. Motion

| 토큰 | 용도 |
|---|---|
| motion.fade | 요소 나타남·사라짐 전환 |
| motion.slide | 패널·서랍 슬라이드 |
| motion.scale | 팝오버·다이얼로그 진입 |

원칙:
- 에디터 콘텐츠 영역(L0)에서는 모션을 최소화한다 — 코딩 집중을 방해하지 않는다.
- `prefers-reduced-motion` 미디어 쿼리를 반드시 존중한다.
- 지속시간은 150~220ms 범위를 기본으로 한다. 정보 전달이 목적이며 연출이 목적이 아니다.

실제 값 정본: `→ src/shared/design-tokens/semantic.ts`

---

## §7. Interaction — 9-State + Redundant Encoding

### 9개 인터랙션 상태

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
| empty | 콘텐츠 없음 — 전용 토큰 없음, `editor.text.muted` + `surface.*` 조립 패턴 |

### Redundant Encoding 원칙

상태는 **색 단독으로 전달해서는 안 된다.** 각 상태는 색 + 형태·서피스 변화 중 최소 2종을 동시 사용한다.

| 상태 | 색 | 형태·서피스 |
|---|---|---|
| hover | surface 미세 변화 | 배경 서피스 level 상승 |
| active | surface 추가 변화 (hover보다 강함) | 배경 서피스 level 추가 상승 또는 scale 축소 |
| focus | ring 색 표시 | 2px outline + offset, ring ≥ 3:1 대비 |
| selected | 강조색 | bold 또는 left border indicator |
| error | error 토큰 색 | 아이콘 + border 변화 |
| disabled | opacity 감소 | pointer-events: none |
| loading | — | 인라인 스피너 (`state.loading.indicator` 색) |

### 라이트 테마 오버레이 방향

다크 테마에서 hover/active 오버레이는 밝은 방향(흰색 rgba)으로 작동한다.
라이트 테마에서는 **어두운 방향**으로 반전되어야 한다.
`frostedVeil` 계열처럼 rgba 흰색을 하드코딩하면 라이트 테마에서 hover가 소실된다.
오버레이는 반드시 `state.hover.bg`, `state.active.bg` semantic 토큰으로 참조한다.

### Diff / Git Lane 색 예외

diff 추가·삭제 레인, git 그래프 lane은 **색이 본질적 의미**를 전달하는 통제된 예외다.
redundant encoding 원칙의 예외를 허용하되, 보조 인코딩을 제공해야 한다:
- diff: 추가(녹색 계열) + `+` 기호 / 삭제(적색 계열) + `-` 기호
- git graph: commit 노드 = 원형, merge 노드 = 마름모 형태로 보조 인코딩

---

## §8. Token Tiering — Primitive → Semantic → Component

### 3-Tier 구조

```
primitive.ts
  ↓
  원시 색·스페이싱·라디우스·폰트 값
  테마가 직접 참조하지 않음

semantic.ts
  ↓
  SemanticKey 타입 정의 (역할명 빈 키 계약)
  Record<SemanticKey, string> — 누락 시 TS2741 컴파일 에러
  값을 담지 않고 키만 정의

themes/warm-dark.ts, themes/cool-dark.ts, themes/warm-light.ts …
  ↓
  SemanticKey 전체 충족
  primitive 값을 참조해 채움

component.ts
  ↓
  buildShadcnVars(tokens): Radix/shadcn CSS 변수 어댑터
  semantic → shadcn --변수명 매핑
  SemanticKey에서 제외된 SEALED 상수 포함
```

### SEALED 상수

테마가 변경할 수 없는 값. `component.ts`에 상수로 고정, `SemanticKey`에서 제외.

| 상수 | 값 | 의미 |
|---|---|---|
| --shadow-sm ~ --shadow-2xl | none | 그림자 없는 엘리베이션 철학 |

### 초기 테마 셋 (T2)

| 테마 ID | 파일 | hue 방향 | 명도 | 상태 |
|---|---|---|---|---|
| warm-dark | themes/warm-dark.ts | 웜 옐로~황록 계열 (themes/warm-dark.ts 참조) | 다크 (낮은 명도) | 기본·플래그십 |
| cool-dark | themes/cool-dark.ts | 쿨 블루~시안 계열 (themes/cool-dark.ts 참조) | 다크 (낮은 명도, warm-dark 동일) | 명시 선택 |
| warm-light | themes/warm-light.ts | 웜 옐로~황록 계열, warm-dark와 동일 hue 패밀리 (themes/warm-light.ts 참조) | 라이트 (높은 명도) | OS Auto 페어 |

OS Auto 페어: warm-dark ⇄ warm-light (동일 hue 패밀리, hue 점프 없음).
cool-dark는 명시 선택 시 OS 추종 해제·고정 (P1).

---

## §9. Region Semantics — region.element.role Vocabulary

토큰 명명 규칙: `<region>.<element>.<role>` 3세그먼트 flat 문자열 키.
`semantic.ts`의 `SemanticKey` freeze 기준이 된다.

### 전역 Surface (4종)

| SemanticKey | 서피스 레벨 | 설명 |
|---|---|---|
| surface.canvas.bg | L0 | 에디터 캔버스 배경 |
| surface.canvas.fg | L0 | 캔버스 위 기본 전경색 |
| surface.chrome.bg | L1 | titlebar + sidebar chrome 배경 |
| surface.chrome.fg | L1 | chrome 영역 기본 전경색 |
| surface.chrome.border | L1 | chrome 하단·우측 hairline |
| surface.panel.bg | L2 | 패널·탭바 배경 |
| surface.panel.fg | L2 | 패널 기본 전경색 |
| surface.panel.border | L2 | 패널 경계 hairline |
| surface.floating.bg | L3 | 팝오버·다이얼로그·툴팁 배경 |
| surface.floating.fg | L3 | floating 기본 전경색 |
| surface.floating.border | L3 | floating 외곽선 (서피스 레벨 대비 + hairline으로 입체감 표현) |
| surface.floating.scrim | L3 | 모달 backdrop scrim 색 (그림자 대체 수단) |

### 전역 State

인터랙션 상태 토큰. 리전에 무관하게 모든 컴포넌트가 공통 참조한다.

| SemanticKey | 설명 |
|---|---|
| state.hover.bg | hover 상태 배경 오버레이 (다크: 밝은 방향 / 라이트: 어두운 방향) |
| state.active.bg | active(마우스 다운) 상태 배경 오버레이 |
| state.selected.bg | selected 상태 배경 |
| state.selected.fg | selected 상태 전경색 |
| state.selected.indicator | selected 상태 좌측 indicator 색 |
| state.focus.ring | focus ring 색 (≥ 3:1 대비, 2px outline 필수) |
| state.disabled.fg | disabled 상태 전경색 (opacity 감소 표현) |
| state.disabled.bg | disabled 상태 배경 |
| state.error.fg | error 상태 전경색 |
| state.error.border | error 상태 border 색 |
| state.error.bg | error 상태 배경 |
| state.warning.fg | warning 상태 전경색 |
| state.warning.border | warning 상태 border 색 |
| state.warning.bg | warning 상태 배경 |
| state.loading.indicator | 로딩 인디케이터 색 (스피너·진행 바) |

### 전역 Feedback

성공·정보 피드백 레이어. 컨트롤 인터랙션 상태가 아니라 결과 알림 레이어이므로 `state.*`와 분리한다.

| SemanticKey | 설명 |
|---|---|
| feedback.success.fg | 성공 피드백 전경색 |
| feedback.success.border | 성공 피드백 border 색 |
| feedback.success.bg | 성공 피드백 배경 |
| feedback.info.fg | 정보 피드백 전경색 |
| feedback.info.border | 정보 피드백 border 색 |
| feedback.info.bg | 정보 피드백 배경 |

### IDE 리전 8개

#### editor (에디터)

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

#### sidebar (사이드바 / 파일트리)

| SemanticKey | 설명 |
|---|---|
| sidebar.bg | 사이드바 배경 (≈ chrome L1) |
| sidebar.fg | 사이드바 기본 텍스트 |
| sidebar.item.hover.bg | 항목 hover 배경 |
| sidebar.item.selected.bg | 선택 항목 배경 |
| sidebar.item.selected.fg | 선택 항목 텍스트 |
| sidebar.item.indicator | 선택 항목 좌측 indicator (선 또는 배경) |
| sidebar.icon.fg | 파일 트리 아이콘 기본색 |
| sidebar.badge.bg | 배지 배경 (변경 카운트 등) |
| sidebar.badge.fg | 배지 텍스트 |

#### tab (탭바)

| SemanticKey | 설명 |
|---|---|
| tab.bar.bg | 탭바 배경 |
| tab.active.bg | 활성 탭 배경 |
| tab.active.fg | 활성 탭 텍스트 |
| tab.active.border | 활성 탭 하단 강조선 |
| tab.inactive.bg | 비활성 탭 배경 |
| tab.inactive.fg | 비활성 탭 텍스트 |
| tab.hover.bg | 탭 hover 배경 |
| tab.modified.dot | 수정됨 표시 점 색 |

#### panel (하단 패널)

| SemanticKey | 설명 |
|---|---|
| panel.bg | 하단 패널 배경 |
| panel.fg | 패널 기본 텍스트 |
| panel.header.bg | 패널 헤더 배경 |
| panel.header.fg | 패널 헤더 텍스트 |
| panel.tab.active.fg | 패널 활성 탭 텍스트 |
| panel.tab.inactive.fg | 패널 비활성 탭 텍스트 |
| panel.border | 패널 상단 경계선 |

#### terminal (터미널)

| SemanticKey | 설명 |
|---|---|
| terminal.bg | 터미널 배경 (L0, xterm background API 용) |
| terminal.fg | 터미널 기본 전경색 |
| terminal.cursor.color | 터미널 커서 색 |
| terminal.cursor.accent | 커서 블록 내부 텍스트 색 |
| terminal.selection.bg | 선택 배경 |

#### diff (diff 뷰어)

| SemanticKey | 설명 |
|---|---|
| diff.added.bg | 추가 라인 배경 |
| diff.added.fg | 추가 라인 텍스트 |
| diff.added.gutter | 추가 라인 gutter 배경 |
| diff.deleted.bg | 삭제 라인 배경 |
| diff.deleted.fg | 삭제 라인 텍스트 |
| diff.deleted.gutter | 삭제 라인 gutter 배경 |
| diff.modified.bg | 수정 라인 배경 |
| diff.unchanged.fg | 미변경 라인 텍스트 (muted) |

#### git (git 패널 / 그래프)

| SemanticKey | 설명 |
|---|---|
| git.lane.0 | 그래프 lane 0 색 |
| git.lane.1 | 그래프 lane 1 색 |
| git.lane.2 | 그래프 lane 2 색 |
| git.lane.3 | 그래프 lane 3 색 |
| git.lane.4 | 그래프 lane 4 색 |
| git.lane.5 | 그래프 lane 5 색 |
| git.lane.6 | 그래프 lane 6 색 |
| git.lane.7 | 그래프 lane 7 색 |
| git.node.commit.fill | commit 노드 (원형) 채움색 |
| git.node.merge.fill | merge 노드 (마름모) 채움색 |
| git.node.tag.fill | 태그 노드 채움색 |
| git.label.branch.bg | 브랜치 레이블 배경 |
| git.label.branch.fg | 브랜치 레이블 텍스트 |
| git.label.remote.bg | 원격 레이블 배경 |
| git.label.remote.fg | 원격 레이블 텍스트 |
| git.status.added.fg | Staged/Added 상태 텍스트 |
| git.status.modified.fg | Modified 상태 텍스트 |
| git.status.deleted.fg | Deleted 상태 텍스트 |
| git.status.untracked.fg | Untracked 상태 텍스트 |
| git.status.conflict.fg | Conflict 상태 텍스트 |

#### status (상태바)

| SemanticKey | 설명 |
|---|---|
| status.bar.bg | 상태바 배경 |
| status.bar.fg | 상태바 기본 텍스트 |
| status.bar.item.hover.bg | 상태바 항목 hover 배경 |
| status.bar.error.bg | 오류 강조 배경 |
| status.bar.error.fg | 오류 강조 텍스트 |
| status.bar.warning.bg | 경고 강조 배경 |
| status.bar.warning.fg | 경고 강조 텍스트 |

### terminal.ansi.* 16키

ANSI 16색 팔레트. xterm `ITheme` 타입과 1:1 대응.
Record<ThemeId, ITheme>는 `src/shared/design-tokens/themes/terminal-palette.ts`에서 관리.

| SemanticKey | ANSI 역할 |
|---|---|
| terminal.ansi.black | ANSI 0 — normal black |
| terminal.ansi.red | ANSI 1 — normal red |
| terminal.ansi.green | ANSI 2 — normal green |
| terminal.ansi.yellow | ANSI 3 — normal yellow |
| terminal.ansi.blue | ANSI 4 — normal blue |
| terminal.ansi.magenta | ANSI 5 — normal magenta |
| terminal.ansi.cyan | ANSI 6 — normal cyan |
| terminal.ansi.white | ANSI 7 — normal white |
| terminal.ansi.brightBlack | ANSI 8 — bright black (dark gray) |
| terminal.ansi.brightRed | ANSI 9 — bright red |
| terminal.ansi.brightGreen | ANSI 10 — bright green |
| terminal.ansi.brightYellow | ANSI 11 — bright yellow |
| terminal.ansi.brightBlue | ANSI 12 — bright blue |
| terminal.ansi.brightMagenta | ANSI 13 — bright magenta |
| terminal.ansi.brightCyan | ANSI 14 — bright cyan |
| terminal.ansi.brightWhite | ANSI 15 — bright white |

---

## §10. Theme Authoring Rules

새 테마를 추가하거나 기존 테마를 수정할 때 반드시 준수해야 하는 규칙.

### WCAG 대비 게이트 (필수)

| 항목 | 최소 대비비 | 기준 |
|---|---|---|
| 본문 텍스트 (appBody, appBodyEmphasis) | 4.5:1 | WCAG 2.2 §1.4.3 |
| 대형 텍스트 (18px Bold 또는 24px Regular 이상) | 3:1 | WCAG 2.2 §1.4.3 |
| UI 컴포넌트 경계·상태 표시 | 3:1 | WCAG 2.2 §1.4.11 |
| 포커스 링 (focus ring) | 3:1 이상 + 최소 2px | WCAG 2.2 §2.4.11 |
| 색 단독 정보 전달 | 금지 | WCAG 2.2 §1.4.1 |

muted 텍스트(11~13px) 구간이 최고 위험 구간이다. appUiSm / appUiXs 는 배경 대비 4.5:1 이상을 유지해야 한다.

### 라이트 테마 추가 규칙

- hover / active 오버레이는 어두운 방향(dark rgba)으로 구현한다.
- 흰색 rgba 오버레이(`frostedVeil` 계열)는 라이트 테마에 사용할 수 없다.
- hairline(존 경계)은 다크 테마보다 불투명도를 높여 소실되지 않도록 한다.
- frosted-veil 대비가 WCAG 1.4.11 3:1 기준을 충족하는지 반드시 측정한다.

### SemanticKey 충족 게이트

`semantic.ts`의 `Record<SemanticKey, string>` 타입이 컴파일 타임에 누락을 TS2741로 검출한다.
빌드 에러 없이 테마 파일을 추가할 수 없으면 vocabulary가 불완전한 것이다.

### 테마 적용 방식

빌드타임에 모든 테마 CSS를 생성, 런타임은 `documentElement`의 `data-theme` 속성만 변경.
FOUC 방지를 위해 `index.html <head>` 인라인 부트 스크립트가 `localStorage`에서 themePreference를 동기 읽기.
영속화: `localStorage`(부트 캐시) + `appState`(정본) 이중 기록.
`main` 프로세스 `titleBarOverlay` 색 동기화는 `appState` 경유.

---

## §11. Anti-patterns

이 섹션은 발견되면 즉시 수정해야 하는 금지 패턴이다.

| 패턴 | 이유 | 대안 |
|---|---|---|
| 색값(hex/oklch/rgba) 하드코딩 | 테마 전환 불가, 드리프트 발생 | semantic 토큰 참조 |
| `rgba(255,255,255,…)` 오버레이 — 라이트 테마 | hover 소실 | `state.hover.bg` 토큰 참조 |
| 상태를 색 단독 신호 | 색맹 접근성 위반 | redundant encoding |
| 마케팅 타입스케일 역할(80px display 등) in-app 사용 | 밀도 철학 위반 | appTypeScale 사용 |
| 4pt 외 스페이싱(5, 10, 14, 15px 등) | 4pt 그리드 위반 | 8단계 space 토큰 |
| 라디우스 4단계 외 값 | 형태 일관성 파괴 | none/control/container/full |
| SemanticKey 미포함 토큰 직접 사용 | vocabulary 외부로 확장 불가 | semantic.ts에 키 추가 후 사용 |
| design.md에 색값 기록 | 드리프트 보장, 자기모순 | themes/*.ts에만 색값 |
| 존재하지 않는 파일 경로 참조 (주석 포함) | 오참조 혼란 | 실재 확인 후 참조 |
| 그림자 추가 (`box-shadow` 값 지정) | 그림자 없는 엘리베이션 철학 위반 | 서피스 레벨 차이 + hairline |
| 순수 #000 또는 #fff 사용 | 톤 불변 원칙 위반 | hue 틴트된 뉴트럴 사용 |

---

## §12. Agent Guide

이 문서를 참조해 코드를 작성하는 LLM 에이전트를 위한 가이드.

### 토큰 참조 순서

1. `semantic.ts`에서 SemanticKey 존재 여부 확인
2. 없으면 semantic.ts에 키 추가 (vocabulary 확장), 기존 테마 파일 전부 업데이트
3. 컴포넌트는 CSS 변수(`var(--<key>)`)로 참조, 절대 색값 하드코딩 금지
4. 새 테마 파일 추가 시 모든 SemanticKey 충족 후 빌드 확인

### 상태 구현 체크리스트

- [ ] hover: `state.hover.bg` 토큰 + 서피스 레벨 변화 (색 단독 금지)
- [ ] active: `state.active.bg` 토큰 + hover보다 강한 서피스 변화 또는 scale 축소
- [ ] focus: `state.focus.ring` 토큰 + 2px outline + offset 명시
- [ ] selected: 강조색 + 좌측 indicator 또는 font-weight 변화
- [ ] error: error 토큰 색 + 아이콘 + border 변화
- [ ] disabled: opacity 감소 + pointer-events none
- [ ] loading: `state.loading.indicator` 토큰 색 인라인 스피너 + 텍스트 레이블 동반

### 리전 토큰 선택

- L0 영역(에디터·터미널): `surface.canvas.*` 또는 `editor.*` / `terminal.*`
- L1 영역(titlebar·sidebar): `surface.chrome.*` 또는 `sidebar.*`
- L2 영역(패널·탭): `surface.panel.*` 또는 `tab.*` / `panel.*`
- L3 영역(팝오버·다이얼로그): `surface.floating.*`
- 상태바: `status.bar.*`
- git 그래프: `git.lane.0` ~ `git.lane.7` (lane은 색-구분 예외, 형태 보조 인코딩 필수)
- diff 뷰어: `diff.added.*` / `diff.deleted.*` / `diff.modified.*`
- ANSI 터미널 색: `terminal.ansi.*` 16키

### 금지 사항 요약

- 색값 하드코딩 금지
- 마케팅 타입스케일 in-app 사용 금지
- 4pt 외 스페이싱 금지
- 그림자(`box-shadow` 값) 추가 금지
- 라디우스 4단계 외 값 금지
- 오버레이에 `rgba(255,255,255,…)` 하드코딩 금지 (라이트 테마 소실)
- design.md에 색값 추가 금지 — `→ src/shared/design-tokens/themes/*.ts`에만
