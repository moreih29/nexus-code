# Split Engine — VSCode Grid 패턴 차용한 분할 로직 전담 레이어

- Date: 2026-05-03
- Status: Accepted

## Context

현재 `src/renderer/store/layout/` 아래 단일 helpers.ts(217줄)가 순수 트리 알고리즘(traversal, insertion, removal)과 도메인 로직(tabIds 관리, dangling-tab 정리)을 혼재한다. Zustand store(store.ts)는 helpers를 직접 호출하며, `useSplitSash.ts`는 `Math.min(0.95, Math.max(0.05, px / size))` 인라인 산술을 반복한다. 이 구조는 엔진 단위 테스트를 어렵게 하고, 분할 알고리즘을 다른 컨텍스트에서 재사용할 수 없게 만든다.

VSCode는 이 문제를 3-레이어로 분리해 해결한다.
- `vs/base/browser/ui/grid/grid.ts` — 도메인 무관 분할 엔진(Grid<T> 클래스)
- `vs/workbench/browser/parts/editor/editorPart.ts` — 에디터 도메인 어댑터
- `vs/workbench/services/editor/browser/editorGroupsService.ts` — 서비스 레이어

이번 결정은 그 패턴을 참고하여 renderer 전용 제네릭 분할 엔진 레이어를 신설한다.

## Decision

1. **엔진 위치**: `src/renderer/split-engine/` (renderer 전용). main 프로세스와 공유하지 않는다.

2. **API 형태**: 순수 함수 네임스페이스 `Grid` (클래스 인스턴스 아님). 호출 측: `Grid.addView(...)`, `Grid.collapseEmptyLeaves(...)`, `Grid.MIN_RATIO`.

3. **좌표계**: `Direction = "up" | "down" | "left" | "right"` 문자열 리터럴 유니온. 내부에서 `(orientation, side)` 쌍으로 변환한다.

4. **트리 구조**: 이진 트리 유지. n-ary 전환은 후속 작업으로 분리한다.

5. **Sizing 정책**: 보류. 신규 split은 ratio 0.5 고정. n-ary 전환 시 함께 도입한다.

6. **sanitize 분리**: 엔진은 `collapseEmptyLeaves(tree)` 만 담당한다. 도메인 단의 `stripDanglingTabs(tree, knownTabIds)` 는 Phase B2에서 분리한다.

7. **SerializedNode 호환**: 엔진 SplitNode 타입(`SplitLeaf`, `SplitBranch`)은 기존 `LayoutLeaf`, `LayoutSplit`와 동일 필드명을 사용한다. 영속 스키마 변경 없음 — 결정 #7.

8. **마이그레이션 전략**: 4단계 점진 마이그레이션. 이번 task는 Phase A.

9. **ResizeHandle 보존**: 컴포넌트 구조는 유지하고, sash 계산 수학만 추출한다(`sash-math.ts`).

## Consequences

### 긍정

- 분할 엔진을 순수 함수 집합으로 단위 테스트할 수 있다.
- 도메인(tabIds, workspace) 의존 없이 재사용 가능하다.
- traversal / tree / serialize / sash-math 파일 단위로 책임이 명확히 분리된다.
- idFactory 주입 패턴으로 테스트 격리가 강화된다.

### 부정 및 한계

- **이진 트리 한계**: 동방향 3분할 시 가운데 sash는 우측 sash가 아닌 좌측 분기의 비율만 변경한다. 이는 n-ary 전환 전까지 비직관적 동작을 유발할 수 있다. n-ary 후속 작업으로 해결 예정.

- **Sizing 정책 도입 보류**: 현재 ratio 0.5 고정이며 크기 힌트(SizeDistribution 등)를 표현할 방법이 없다. n-ary 전환 시 함께 진화한다.

- **SerializedNode 스키마 변경 없음**: 현재 필드 구조를 그대로 유지한다. 미래에 브레이킹 변경이 필요하면 `version` 필드 추가와 마이그레이션 함수가 필요하다.

## Alternatives Considered

- **클래스 인스턴스**: 상태를 인스턴스에 보유하면 Zustand store와 이중 진실 원천이 생긴다. 기각.
- **n-ary 즉시 전환**: 영속 스키마 재설계와 기존 serialized 데이터 마이그레이션이 필요하다. 위험 대비 이득이 불분명. 기각, 후속으로 분리.
- **Sizing 타입만 도입**: 이진 트리에서 Sizing이 의미를 갖는 경우가 한정적이다. n-ary 없이 도입하면 중간 추상이 된다. 기각.
- **SerializedNode 재설계**: 기존 저장 데이터와 호환성 단절을 초래한다. 기각 — version 필드 마이그레이션을 통해 점진 진화.
- **빅뱅 마이그레이션**: store, helpers, 컴포넌트를 한 번에 교체. 리그레션 위험이 크고 리뷰 단위가 너무 커진다. 기각.

## Migration Plan

| Phase | 작업 | 변경 파일 |
|-------|------|-----------|
| A (이번) | split-engine 모듈 신설, helpers.ts와 병존 | `src/renderer/split-engine/*` |
| B1 | store 구조 메서드(splitGroup, closeGroup, setSplitRatio)가 엔진 함수 위임 | `store.ts`, `operations.ts` |
| B2 | 도메인 메서드(detachTab, sanitize)를 도메인 레이어로 분리, `stripDanglingTabs` 이전 | `store.ts`, `operations.ts` |
| C | helpers.ts 제거, useSplitSash에서 sash-math 함수 사용 | `helpers.ts` 삭제, `useSplitSash.ts` |
