# react-resizable-panels 실패 기록

## 요약

`react-resizable-panels@4.10.0` + React 19.2.5 + Tailwind v4.2.4 + Electron 35.7.5 + shadcn forwardRef wrapper 조합에서 **드래그 확장 방향이 동작하지 않는 증상**을 마주쳤다. 축소는 되고 확장만 안 되는 비대칭 실패. 4회 hotfix에도 해결되지 않았고, 결국 **library를 완전히 제거하고 순수 pointer event 기반 custom resize**로 교체하는 것으로 해결됐다.

## 구체 증상

DevTools 실측(Nexus 창 725×772):

```json
{
  "panels": [
    { "flex": "0 1 0px", "width": 0, "dataSize": null },
    { "flex": "97.579 1 0px", "width": 645, "dataSize": null },
    { "flex": "2.421 1 0px", "width": 16, "dataSize": null }
  ],
  "localStorage": {
    "workspace": "{\"collapsed\":false,\"size\":17}",
    "shared": "{\"collapsed\":false,\"size\":20}"
  }
}
```

- `defaultSize={17}` / `defaultSize={20}`을 줬음에도 실제 렌더는 0 / 2.4%
- `data-panel-size` · `data-panel-id` attr가 null
- localStorage 복원값과 실제 렌더가 불일치
- drag는 pointer listener 수준에서 동작하나 delta가 library 내부 layout solver에 제대로 반영되지 않음

## 시도하고 실패한 가설 (commit hash 기준)

| Commit | 가설 | 결과 |
|---|---|---|
| 9f863a1 | localStorage 스키마 오염 | 실패 |
| 46377aa | hit area 확장 + inner grip pointer-events-none + onResize debounce | 실패 |
| ba2fdf8 | onResize setState 제거로 re-render 간섭 차단 | 실패 |
| 9efd366 | maxSize 상한 증대(28→50, 32→50) 진단 실험 | 원인 아님 확정 |
| 6f0b61e | collapsible + collapsedSize 제거로 drag-triggered auto-collapse 차단 | 실패(단축키 conditional render는 성공) |
| 24ebee1 | **library 완전 제거, custom pointer handler** | **성공** |

## 추정 원인

확증은 없으나 상황 증거:

1. **v4의 percentage 기반 layout solver**가 우리 조합(React 19 concurrent + Tailwind v4 cascade layer + shadcn forwardRef + Fragment 포함 children + 조건부 렌더)에서 수렴점을 잘못 계산. `defaultSize` 합이 100이 아닐 때 자동 할당하는 로직과 flex-grow 변환에서 경계 조건
2. `data-panel-size: null`이 정상 동작이라는 engineer 분석 — v4 소스에서 attr를 노출 안 함. 그러나 이것이 우리가 외부에서 layout 상태를 관찰할 수 있는 유일한 창구가 없다는 의미 = 디버깅 극도로 어려움
3. shadcn wrapper가 `forwardRef`로 `panelRef` prop에 매핑하는데, v4 API는 `ref` prop 사용. 이 매핑이 ref forward 자체는 동작하지만 내부 측정 타이밍에 미세 차이

## 교훈

1. **layout-critical library를 블랙박스로 쓰지 말 것**. 내부 state 관찰 경로(`data-*` attr, debug hook)가 없는 layout solver는 실패 시 디버깅 불가
2. **v4 migration cost**: v3→v4 breaking change(`panelRef`→`ref`, `onCollapse`/`onExpand` 제거)만 문서화되고, solver 동작 변경은 CHANGELOG에 명시 안 됨. major version 업데이트 신중
3. **bypass 가치**: CSS flex row + `onPointerDown`/Move/Up + pixel delta 직접 조작 = 80줄 미만으로 동등 기능 구현 가능. layout이 percentage 기반일 이유가 없으면 pixel이 안전
4. bundle size: library 제거 후 1701 → 1648KB (**-53KB**). 순수 이득

## 우리 환경에서 현재 선택

- react-resizable-panels **사용 안 함** (commit 24ebee1에서 package.json·shadcn wrapper 제거)
- `packages/app/src/renderer/App.tsx`의 `onPointerDown` 기반 custom layout 유지
- 다시 이 library 검토 시 본 기록을 먼저 참조

## 외부 참고

- GitHub bvaughn/react-resizable-panels issues: #456(drag 중 setState 빈번 회귀), #594(v4.3.1 capture phase + Radix Portal 간섭), #532(v4 className wrapper 내부 적용)
- CHANGELOG 4.5.3 · 4.5.8: collapsible snap 동작 여러 회귀
- 4.7.4: pointer capture iframe fix (우리가 겪은 증상은 이와 별개)
