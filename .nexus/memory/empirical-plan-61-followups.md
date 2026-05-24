# Plan 61 follow-ups

Plan 61 사이클(에디터 탭바 + 메뉴 확장 — 신규 파일 / 터미널 / 브라우저) 종료 시점
architect 2차 리뷰에서 분리된 후속 항목. 사이클 close 시 등록.

## GAP-A · editor 탭 origin forward 누락 (WARNING)

- 위치: `src/renderer/components/workspace/content/host.tsx` editor 분기
- 증상: `tab.props.origin` / `readOnly`를 `EditorView` prop으로 forward하지 않음 →
  `external` origin 탭이 `useSharedModel`에 `origin=undefined`로 전달되어
  `cache.ts`의 `createEntry` 분기로 빠짐
- 시점: HEAD 시점부터 존재한 latent 결함. Plan 61 T25에서 `useSharedModel.origin`
  전파 버그를 고치면서 노출 표면이 커짐.
- 우선순위: external 탭 사용량에 따라 결정. 단순 fix(props forward + EditorView
  prop 확장) 한 사이클로 충분.

## GAP-B · 차단된 스킴이 UrlBar에 그대로 노출 (INFO, 1차 W2)

- 위치: `src/renderer/components/editor/browser/url-bar.tsx`
- 증상: javascript: / data: / file: / about: 등 NAVIGATION_SCHEME_ALLOWLIST 차단
  스킴이 lastUrl로 저장됐을 때 UrlBar에 그대로 표시됨. resolveInitialBrowserUrl이
  navigation은 막지만 표시는 막지 않음.
- 영향: UX gap (사용자에게 실제 navigate되는 URL과 표시 URL 불일치)
- 처방: UrlBar 값 source를 `runtime.currentUrl`로 고정하거나, 차단 스킴이면 빈
  문자열 표시.

## GAP-C · ⌘N / ⌘T 글로벌 단축키 미연결 (INFO, 1차 W3)

- 위치: `src/renderer/components/workspace/tabs/tab-bar.tsx` (드롭다운 메뉴
  shortcut hint)
- 증상: 메뉴 항목에 `⌘N` hint 표시되지만 글로벌 단축키 wiring 없음 → false
  affordance.
- 처방: hint 제거 또는 src/renderer/commands에서 ⌘N → openNewUntitledTab 등록.

## 사이클 외 의도적 deferral

- 검색 엔진 사용자 선택권 (settings UI) — Issue 5 결정에서 명시
- dirty untitled 컨펌 다이얼로그 — Issue 2 결정에서 명시
- 브라우저 즐겨찾기 / 히스토리 / 다운로드 정책 — 사이클 범위 밖
