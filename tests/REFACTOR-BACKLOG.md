# 테스트 리팩터 백로그

본 문서는 `chore/test-overhaul` 브랜치의 wave별 작업 잔여 목록을 기록한다.
W4(렌더러 분류)는 아래 "렌더러 테스트 분류" 섹션에 작성됐으며, 다른 wave는 하단 빈 섹션에 append한다.

---

## 렌더러 테스트 분류 (W4)

분류 기준:
- **(C) 순수로직 격리 — 보존**: UI 밖 순수 로직/알고리즘 격리 검증. render 불필요가 정당.
- **(B) 구현결합 — W3b 대상**: zustand 내부 구조(byWorkspace 직접 참조·동치·참조 안정성)나 mock 호출 순서/횟수 결합으로 동작 변경 없는 리팩터링에 깨질 위험.
- **(R) render() 권장 후보 — next-cycle**: 사용자 관점 UI 동작(렌더 결과·이벤트·접근성)을 로직 격리로 우회 중이라 next-cycle에 `render()` 기반으로 승격하면 신뢰가 오를 후보.

분류 방법: 파일 헤더·import·단언 패턴을 기준으로 훑어 분류했다.
디렉터리 단위로 패턴이 동일한 경우 괄호 내 파일 수로 일괄 처리, B·R은 파일명을 개별 명시했다.

---

### (C) 순수로직 격리 — 보존

#### engine/

| 파일 | 사유 |
|------|------|
| `renderer/engine/split-engine.test.ts` | 순수 분할 알고리즘, 상태·DOM 없음 |

#### keybindings/ (8파일, 전부 C)

패턴: 순수 함수(resolver·chord-state·dispatcher·context-keys) 또는 커맨드 레지스트리 격리 로직. Zustand 내부 직접 접근 없음.

| 파일 | 사유 |
|------|------|
| `keybindings/chord-state.test.ts` | 순수 chord 상태 머신 |
| `keybindings/context-keys.test.ts` | 순수 컨텍스트 키 평가 |
| `keybindings/dispatcher.test.ts` | 커맨드 레지스트리 주입, mock 결과 단언 병행 |
| `keybindings/file-copy-cut-multi.test.ts` | 커맨드 핸들러 로직 격리 |
| `keybindings/file-delete.test.ts` | 커맨드 핸들러 격리, IPC 단언 병행 |
| `keybindings/file-rename-f2.test.ts` | 커맨드 핸들러 격리 |
| `keybindings/palette-command-keybinding.test.ts` | 팔레트 커맨드 등록 검증 |
| `keybindings/resolver.test.ts` | 순수 키 해석 로직 |

#### services/browser/ (1파일)

| 파일 | 사유 |
|------|------|
| `services/browser/url-classifier.test.ts` | 순수 URL 분류 함수 |

#### services/editor/ (순수 로직 파일)

| 파일 | 사유 |
|------|------|
| `services/editor/conflict-parser-parse.test.ts` | 순수 파서, 입출력 검증 |
| `services/editor/conflict-parser-actions.test.ts` | 파서 액션, 순수 로직 |
| `services/editor/dirty-tracker.test.ts` | 모델 이벤트 격리 테스트, DI 패턴 |
| `services/editor/attach-git-subscription.test.ts` | Deps 주입 패턴, 타이머 fake 사용 |
| `services/editor/save-sequentializer.test.ts` | 순수 순차화 로직 |
| `services/editor/model-entry.test.ts` | 모델 엔트리 라이프사이클 격리 |
| `services/editor/model-cache-acquire-error.test.ts` | 캐시 취득 에러 경로 격리 |
| `services/editor/model-cache-acquire-external.test.ts` | 캐시 취득 외부 경로 격리 |
| `services/editor/model-cache-release.test.ts` | 캐시 해제 로직 격리 |
| `services/editor/model-cache-workspace-cleanup.test.ts` | 워크스페이스 클린업 격리 |
| `services/editor/model-entry-didopen-gate.test.ts` | didOpen 게이트 로직 격리 |
| `services/editor/lsp-result-preacquire.test.ts` | LSP 결과 선취 로직 격리 |
| `services/editor/monaco-compensations.test.ts` | Monaco 보상 로직, 순수 함수 |
| `services/editor/editor-readonly-options.test.ts` | 읽기 전용 옵션 계산 |
| `services/editor/previewable.test.ts` | 미리보기 가능 여부 판단 |
| `services/editor/promote-policy.test.ts` | 탭 승격 정책 순수 로직 |
| `services/editor/reveal.test.ts` | 리빌 로직 격리 |
| `services/editor/disk-diverged.test.ts` | 디스크 분기 감지 로직 |
| `services/editor/load-external-entry.test.ts` | 외부 엔트리 로드 격리 |
| `services/editor/preview/task-toggle.test.ts` | 순수 문자열 변환 (toggleTaskMarker) |
| `services/editor/preview/workspace-url.test.ts` | 순수 URL 빌더 |

#### services/ (기타 서비스)

| 파일 | 사유 |
|------|------|
| `services/file-clipboard/clipboard.test.ts` | 클립보드 로직 격리 |
| `services/file-clipboard/paste-multi.test.ts` | 다중 붙여넣기 로직 격리 |
| `services/fs-mutations.test.ts` | fs 변이 로직 격리, IPC 결과 단언 |
| `services/fs-mutations/confirm-delete-batch.test.ts` | 배치 삭제 확인 로직 |
| `services/fs-mutations/distinct-parents.test.ts` | 순수 부모 필터 함수 |
| `services/fs-mutations/increment-name.test.ts` | 순수 이름 증분 함수 |
| `services/fs-mutations/move-path.test.ts` | 경로 이동 로직 격리 |
| `services/fs-mutations/trash.test.ts` | 휴지통 로직 격리 |
| `services/fs-toast-errors.test.ts` | 토스트 에러 라우팅 격리 |
| `services/lsp-bridge-diagnostics.test.ts` | LSP↔Monaco 변환 순수 함수 |
| `services/lsp-server-ux-router.test.ts` | LSP UX 라우터 격리 |
| `services/lsp/workspace-symbol-registry.test.ts` | 심볼 레지스트리 로직 |
| `services/surface-error.test.ts` | 에러 서피스 라우팅 격리 |
| `services/terminal-services.test.ts` | 터미널 서비스 격리, DI 패턴 |
| `services/window-error-handler.test.ts` | 에러 핸들러 격리 |
| `services/dirty-tracker-saved-listeners.test.ts` | 저장 리스너 격리 |

#### state/selectors/ (1파일)

| 파일 | 사유 |
|------|------|
| `state/selectors/git-action-button.test.ts` | 순수 셀렉터 함수, 입출력 표 패턴 |

#### state/stores/files/ (순수 로직)

| 파일 | 사유 |
|------|------|
| `state/stores/files/selection.test.ts` | 순수 선택 함수들(emptySelection 등), Zustand 무관 |

#### state/stores/ (단순 상태 단언)

| 파일 | 사유 |
|------|------|
| `state/stores/apply-sorted-insert.test.ts` | 순수 정렬 삽입 함수 |
| `state/stores/tab-editing.test.ts` | 단순 editingTabId 상태, byWorkspace 결합 없음 |
| `state/stores/search.test.ts` | 스트림 로직 격리, 상태 단언 정상 수준 |
| `state/stores/search-view-mode.test.ts` | viewMode·expandedDirs 격리, 간단한 상태 단언 |
| `state/stores/git-view-mode.test.ts` | toggleExpandedTreeNode 격리, 단순 상태 단언 |
| `state/stores/git-push-guard.test.ts` | push 가드 시나리오, IPC 결과 단언 병행 |
| `state/stores/ui/files-panel.test.ts` | 패널 너비 상태, 단순 IPC 단언 |

#### state/operations/ (순수 로직 집중)

| 파일 | 사유 |
|------|------|
| `state/operations/reveal-editor-active-file.test.ts` | 파일 노출 정책, selectFocus/selectIsSelected로 결과 단언 |
| `state/operations/files.test.ts` | IPC 경유 트리 로딩, ensureRoot·loadChildren 행위 단언 |
| `state/operations/browser-permission.test.ts` | 퍼미션 구독 설치, 큐 크기 단언 |

#### components/ (순수 로직 또는 renderToStaticMarkup 기반)

| 파일 | 사유 |
|------|------|
| `components/file-tree-keys.test.ts` | 순수 computeParentJumpIndex 함수 |
| `components/workspace-panel-mount.test.ts` | 순수 상태 전이 함수 격리 |
| `components/sidebar-resize.test.ts` | drag 수학(computeNextWidth) 순수 함수 + IPC 단언 |
| `components/files/file-tree-display.test.ts` | 순수 getDisplayFlat 함수 |
| `components/files/file-tree-menu.test.ts` | 순수 buildFileTreeMenuItems 함수 |
| `components/files/file-tree-dnd-drop.test.ts` | drop 핸들러 로직 인라인 격리 |
| `components/files/name-validator.test.ts` | 순수 이름 검증 함수 |
| `components/files/file-tree/file-icon-resolvers.test.ts` | 순수 아이콘 해석 함수 |
| `components/files/file-tree/git-decoration.test.ts` | 순수 데코레이션 함수 |
| `components/files/file-tree/tree-builder.test.ts` | 순수 트리 빌더 |
| `components/files/file-tree/use-tree-keyboard.test.ts` | hook 로직 순수 함수로 추출해 검증 |
| `components/files/git/branch-create-dialog.test.ts` | 브랜치 생성 다이얼로그 로직 격리 |
| `components/files/git/entry-actions-conflict.test.ts` | 충돌 엔트리 액션 로직 |
| `components/files/git/git-destructive-contrast.test.ts` | 파괴적 작업 대비 로직 |
| `components/files/git/git-group-folder-actions.test.ts` | 그룹 폴더 액션 로직 |
| `components/files/git/git-panel-actions.test.ts` | 패널 액션 로직 격리 |
| `components/files/git/git-push-guard-banner.test.ts` | 배너 표시 조건 로직 |
| `components/files/git/history/history-menu.test.ts` | 히스토리 메뉴 빌더 순수 함수 |
| `components/files/git/history/lane-assign.test.ts` | 순수 lane 할당 알고리즘 |
| `components/files/git/pickers/branch-picker-delete-flow.test.ts` | 브랜치 삭제 플로우 로직 |
| `components/files/git/pickers/branch-picker-source.test.ts` | 피커 소스 빌더 |
| `components/files/git/pickers/commit-picker-source.test.ts` | 커밋 피커 소스 빌더 |
| `components/files/git/pickers/ref-picker-source.test.ts` | ref 피커 소스 빌더 |
| `components/files/git/pickers/stash-picker-source.test.ts` | 스태시 피커 소스 빌더 |
| `components/files/git/pickers/tag-picker-source.test.ts` | 태그 피커 소스 빌더 |
| `components/files/git/pickers/workflow-target-picker-source.test.ts` | 워크플로 타겟 피커 |
| `components/lsp/workspace-symbol-source.test.ts` | 팔레트 소스 로직, accept 동작 단언 |
| `components/ui/palette/palette-controller.test.ts` | 팔레트 컨트롤러 순수 로직 (FakeScheduler) |
| `components/ui/palette/palette-focus-restore.test.tsx` | 순수 DOM-free 로직 (FakeElement stub) |
| `components/ui/use-drag-source.test.ts` | drag 이벤트 바인딩 로직, DocStub 사용 |
| `components/ui/use-submenu-placement.test.ts` | 순수 resolveSubmenuPlacement 함수 |
| `components/workbench/dnd/slots.test.ts` | 순수 buildSlotsForGroup / isSlotNoOp |
| `components/workbench/dnd/workspace-row-drag.test.ts` | 순수 payload 파싱/MIME 가드 |
| `components/workbench/split-workspace-groups.test.ts` | 순수 splitWorkspaceGroups 함수 |
| `components/workspace/content/conflict-resolved-banner-predicate.test.ts` | 순수 shouldShowConflictResolvedBanner |
| `components/workspace/content/content-pool-selector.test.ts` | 순수 ownerLeafIdOf 함수 |
| `components/workspace/content/editor-view-open-code-editor.test.ts` | 크로스파일 opener 로직 격리 |
| `components/workspace/content/slot-registry.test.ts` | 슬롯 레지스트리 외부 계약 |
| `components/workspace/dnd/payload.test.ts` | 순수 payload 파싱/MIME 가드 |
| `components/workspace/group/group-tab-bar-menu.test.ts` | 순수 buildGroupTabBarMenuItems |
| `components/workspace/ssh-new-connection-flow.test.ts` | ActionMachine 하네스 격리 |
| `hooks/use-ipc-action.test.ts` | 순수 헬퍼 + ActionMachine 하네스 격리 |

#### renderer 루트 기타

| 파일 | 사유 |
|------|------|
| `dirty-diff-map.test.ts` | 순수 mapChangesToDirty 함수 |
| `i18n-boot.test.ts` | 순수 resolveBootLanguage (localStorage stub) |
| `ipc/client-stream.test.ts` | IPC 스트림 프로토콜 격리 (window.ipc stub) |

**C 소계: 약 104파일**

---

### (B) 구현결합 — W3b 대상

다음 파일들은 zustand store의 내부 구조(특히 `byWorkspace` 객체 참조 동치, `.getState()` 직접 접근, `setState({ byWorkspace: {} })` 초기화 방식)에 결합돼 있다. 동작 변경 없는 내부 리팩터링(예: 키 이름 변경, 참조 안정성 전략 변경)에 깨질 위험이 있다. → **W3b 검토**

| 파일 | 구체적 결합 신호 |
|------|----------------|
| `state/stores/layout/store-structure.test.ts` | `setState({ byWorkspace: {} })` 초기화, `getState().byWorkspace[WS]` 직접 접근 |
| `state/stores/layout/store-tab-lifecycle.test.ts` | 동일 패턴, `getState().byWorkspace` 직접 참조 |
| `state/stores/layout/store-hydration.test.ts` | 동일 패턴 |
| `state/stores/layout/set-active-group.test.ts` | `getState().byWorkspace` 직접 접근 |
| `state/stores/tabs/store.test.ts` | `getState().byWorkspace[WS_A]?.[tabId]` 직접 접근 |
| `state/stores/tabs/pinned-tab.test.ts` | `setState({ byWorkspace: {} })` + `getState().byWorkspace` |
| `state/stores/tabs/new-tab-types.test.ts` | `getState().byWorkspace[WS]` 직접 접근 |
| `state/stores/files/store-query.test.ts` | `setState({ trees: new Map() })` + `getState().trees.get(WS_ID)` 직접 접근 |
| `state/stores/files/store-tree-ops.test.ts` | 동일 패턴 |
| `state/stores/files/store-hydrate-persist.test.ts` | 동일 패턴, `ipcListen.mockClear()` 호출 순서 결합 |
| `state/stores/files/store-selection.test.ts` | `setState({ trees: new Map(), selection: new Map() })` 직접 접근 |
| `state/stores/workspaces.test.ts` | `setState({ workspaces: [], connectionStatusByWorkspaceId: {} })` 직접 구조 노출 |
| `state/stores/git-decorations.test.ts` | `setState({ sessions: new Map() })`, WeakMap 메모이제이션 참조 동치 단언 |
| `state/stores/git-operation-lifecycle.test.ts` | `setState({ sessions: new Map() })` + `ipcCalls` 배열 순서 결합 |
| `state/stores/browser-permissions.test.ts` | `ipcCalls` 배열 + 실제 ipc 호출 순서 단언 |
| `state/stores/browser-suspend.test.ts` | IPC 호출 횟수(0→1→`suspendAll`, edge 전이) 직접 단언 |
| `state/stores/ui/store.test.ts` | `getState().byWorkspace` 직접 접근 패턴 |
| `state/stores/git-operation-lifecycle.test.ts` | ipcCalls push 순서 단언 (mock 호출 순서 결합) |
| `state/operations/dnd.test.ts` | `getState().byWorkspace[WS]` + `findLeaf` 내부 헬퍼 직접 사용 |
| `state/operations/commit-preview.test.ts` | `getState().byWorkspace[WS]` 직접 접근 |
| `state/operations/diff-preview.test.ts` | 동일 패턴 |
| `state/operations/preview-slot-dirty.test.ts` | `getState().byWorkspace[WS]` 직접 접근 |
| `state/operations/tabs-new-types.test.ts` | `getState().byWorkspace[WS]` 직접 접근 |
| `state/claude-status.test.ts` | `byWorkspace` 참조 동치 단언 (`expect(after).toBe(before)`) — 참조 안정성 구현 변경에 직결 |
| `components/files/file-tree-actions.test.ts` | `ipcCalls` 배열 순서 단언 (mock 호출 순서 결합) |
| `components/files/file-tree-actions-copy-cut.test.ts` | mock 호출 횟수·순서 단언 |
| `components/files/file-tree-click-gestures.test.ts` | store `getState()` 직접 접근으로 선택 상태 검증 |
| `components/files/file-tree-keyboard-multi.test.ts` | `getState().selection` 직접 접근 |
| `components/files/files-panel-refs.test.ts` | `refsForGitGroup` 함수가 내부 구현 세부사항(EMPTY_TREE 상수값 등)에 결합 |
| `components/workspace/group/bulk-close-cancel.test.ts` | `editorCloseCalls` 배열 순서 단언 (mock 호출 순서 결합) |
| `components/workspace/group/untitled-tab-close.test.ts` | `cleanupEntry` mock 호출 순서 단언 |
| `services/editor/close-untitled-with-confirm.test.ts` | mock 호출 순서 단언 |
| `services/editor/open-editor.test.ts` | `getState().byWorkspace` 직접 접근 |
| `services/editor/preview-tab.test.ts` | `getState().byWorkspace` + isPreview 내부 필드 직접 단언 |
| `services/editor/save-service.test.ts` | 복잡한 mock.module 조합 + 호출 순서 결합 |
| `services/editor/open-external-editor.test.ts` | mock 호출 순서 단언 |
| `services/files-panel-reconnect.test.ts` | (files-panel-reconnect) mock 호출 단언 |

**B 소계: 약 37파일** → W3b 검토

---

### (R) render() 권장 후보 — next-cycle

다음 파일들은 실제 사용자 관점의 UI 동작(렌더 결과, 접근성, 이벤트 위임)을 `renderToStaticMarkup` 또는 직접 props 추출로 우회 검증 중이다. Testing Library의 `render()` 기반으로 승격하면 실제 DOM 이벤트·포커스 흐름·aria 트리를 검증할 수 있어 신뢰가 오른다. → **next-cycle render() 승격**

| 파일 | 현재 방식 | 승격 이유 |
|------|-----------|-----------|
| `components/files/file-tree-row-4state.test.tsx` | `renderToStaticMarkup` + CSS 클래스 문자열 단언 | 선택·포커스 상태 CSS 매핑은 실제 DOM 클래스 단언이 더 신뢰성 높음 |
| `components/files/file-tree-cut-overlay.test.tsx` | `renderToStaticMarkup` + CSS 문자열 | isCut overlay 시각 효과, DOM 이벤트 없이 검증 중 |
| `components/files/view-mode-toggle.test.tsx` | `renderToStaticMarkup` + aria 문자열 | 버튼 클릭 → viewMode 전환 이벤트 검증 부재 |
| `components/files/files-panel-reconnect.test.ts` | `renderToStaticMarkup` 일부 + 로직 격리 혼재 | EmptyState 렌더와 reconnect 동작을 render()로 통합 가능 |
| `components/workbench/sidebar.test.tsx` | `renderToStaticMarkup` + 아이콘 class 문자열 | 실제 DOM에서 워크스페이스 행 선택·포커스 검증 가능 |
| `components/workbench/pin-toggle.test.tsx` | `renderToStaticMarkup` + aria 문자열 | 클릭 → onToggle 콜백 연결 검증이 props 추출 없이 가능 |
| `components/workbench/sidebar-claude-indicator.test.tsx` | `renderToStaticMarkup` + mock.module로 store 교체 | 상태 글리프 렌더, real store + render()로 통합하면 mock 범위 축소 |
| `components/workbench/dnd/row-drop-indicator.test.tsx` | `renderToStaticMarkup` + CSS 문자열 | 단순하나 pointer-events 동작은 DOM 수준 검증이 적절 |
| `components/workspace/tabs/tab-bar.test.tsx` | `renderToStaticMarkup` + 대규모 mock.module (editor/dnd/drop-target) | 탭 선택·닫기 이벤트 검증 부재; render()로 실제 클릭 단언 가능 |
| `components/workspace/tabs/tab-item-claude.test.tsx` | `renderToStaticMarkup` + useClaudeStatusStore 전체 교체 mock | 상태별 글리프 aria-label을 render()로 단언하면 store mock 범위 축소 |
| `components/workspace/workspace-terminal-status-banner.test.tsx` | `renderToStaticMarkup` + 복잡한 스케줄러/store 조합 | 배너 표시 조건·복수 UI 컴포넌트 조합은 render()가 더 적합 |
| `components/workspace/add-workspace-dialog.test.tsx` | 순수 함수 + `renderToStaticMarkup` 혼재 | 순수 함수 부분은 C로 충분하나, 폼 렌더·입력 유효성 흐름은 render()로 승격 가능 |
| `components/workspace/content/terminal-view-dead.test.tsx` | `renderToStaticMarkup` + React 트리 직접 순회 | DeadTerminalBanner 클릭 → onReopen 콜백 검증을 render()로 단순화 가능 |
| `components/workspace/content/read-only-banner.test.tsx` | `renderToStaticMarkup` + props에서 onClick 직접 추출 | 클릭 이벤트 검증을 render() + fireEvent로 자연스럽게 표현 가능 |
| `components/workspace/content/browser-view.test.tsx` | URL 결정 로직만 검증 (컴포넌트 렌더 없음, 이유 문서화 있음) | DOM 환경 구비 시 실제 URL 결정 경로 포함 render() 검증 가능 |
| `components/ui/form-dialog.test.tsx` | `renderToStaticMarkup` + 순수 헬퍼 혼재 | 폼 상호작용(입력→검증→제출) 흐름은 render()로 단언 가능 |
| `components/ui/toast.test.tsx` | 인라인 미니 컴포넌트 복사 후 `renderToStaticMarkup` | toast.tsx에서 로직 복사로 AP-1(동어반복) 위험 있음; 실제 컴포넌트 render()가 drift 방지 |
| `components/ui/palette/palette-render.test.tsx` | `renderToStaticMarkup` | 팔레트 UI 상태별 렌더(결과·empty·idle 등)는 render() + getByRole이 더 적합 |
| `components/files/git/git-context-menu.test.tsx` | `renderToStaticMarkup` + 순수 menu builder 혼재 | GitFileRow/GitGroup 렌더 결과를 render()로 단언하면 구조 결합 감소 |
| `components/files/git/git-commit-button-menu.test.tsx` | 순수 buildGitCommitMenuModel 함수만 검증 (render 없음, .tsx 확장자만) | C에 가깝지만 UI 메뉴 빌더임 — render() 승격 후 실제 버튼 렌더 포함 가능 |
| `components/files/git/git-helper-dialogs.test.tsx` | `renderToStaticMarkup` + 순수 로직 혼재 | 다이얼로그 폼 상호작용은 render()로 단언 가능 |
| `components/files/git/merge-options-dialog.test.tsx` | `renderToStaticMarkup` | 라디오 선택→CTA 변화 이벤트 검증 부재 |
| `components/files/git/operation-banner.test.tsx` | `renderToStaticMarkup` + 순수 빌더 | OperationBanner 접근성 단언이 aria-live 실제 동작 없이 정적 HTML만 검증 |
| `components/files/git/pickers/tag-picker-dialogs.test.tsx` | `renderToStaticMarkup` | 태그 다이얼로그 입력·제출 흐름 검증 부재 |
| `components/files/git/ref-chip.test.tsx` | 자체 TestDomElement + React Dispatcher 수동 패칭 | 복잡한 fake renderer 대신 render() + screen 단언이 훨씬 단순 |
| `components/files/git/history/history-list-breakpoint.test.tsx` | TestDomElement + ResizeObserver 수동 stub | 브레이크포인트 전환은 render() + ResizeObserver mock이 표준 |
| `components/files/git/history/history-row-breakpoints.test.tsx` | TestDomElement + React 직접 파이버 패칭 | HistoryRow 컬럼 렌더를 render()로 단언하면 내부 fake renderer 불필요 |
| `components/files/git/history/history-segment-toggle.test.tsx` | `renderToStaticMarkup` | 세그먼트 클릭→onChange 이벤트 검증 부재 |
| `components/files/git/history/graph-canvas.test.tsx` | CanvasContextSpy (Canvas 2D API spy) | Canvas 드로우 경로 검증은 spy가 유일 현실적 방법이나, render()로 canvas ref 검증 보완 가능 |
| `services/editor/preview/markdown-interactivity.test.tsx` | `renderToStaticMarkup` | 실제 체크박스 클릭→onToggleTask 이벤트 검증 부재 |
| `services/editor/preview/markdown-security.test.tsx` | `renderToStaticMarkup` | XSS 억제 검증은 정적 markup으로 충분하나, 링크 클릭 차단은 render()가 더 직접적 |
| `services/editor/preview/view-mode-toggle.test.tsx` | `renderToStaticMarkup` | 세그먼트 클릭→onChange 이벤트 검증 부재 |
| `workspace/SshAuthPromptDialog.test.tsx` | `renderToStaticMarkup` | SSH 인증 폼 입력·제출 흐름 검증 부재 |

**R 소계: 약 33파일** → next-cycle render() 승격

---

### 합계

| 분류 | 파일 수 |
|------|--------|
| (C) 순수로직 격리 — 보존 | 약 104 |
| (B) 구현결합 — W3b 대상 | 약 37 |
| (R) render() 권장 후보 — next-cycle | 약 33 |
| **전체** | **약 174** |

> 나머지 약 6파일은 위 분류 중 경계 케이스로, 디렉터리 패턴 기술 시 포함됨 (총 180파일 기준).

---

## (다른 wave 백로그)

각 wave는 핫스팟을 처리하고, 시간·위험상 미처리한 잔여를 아래에 정직하게 기록한다(조용한 누락 금지). 모든 잔여는 게이트 green 상태를 깨지 않는 범위에서 next-cycle 후보다.

### W2 잔여 (결정성 — 실 timer/IO)

**처리 완료(핫스팟 3)**: `status-coalescer.test.ts`(nowFn seam), `browse-session-registry.test.ts`(nowFn seam, 5/60ms 실지연 제거), `keybindings/file-delete.test.ts`(10ms×3→0ms).

**미처리 — 실지연 timer, 테스트 재설계 필요(중간 위험)**:
| 파일 | 사유 |
|------|------|
| `main/agent/pipe-backpressure.test.ts` | 실제 PassThrough 스트림 backpressure를 setTimeout(200ms)+done() 콜백으로 검증. 스트림 종료를 promise로 바꾸는 전체 재설계 필요 |
| `main/agent/pipe-risk3-non-pty-stall.test.ts` | 동일 done() 패턴, KNOWN LIMITATION 주석 있음. 재설계 필요 |
| `main/agent/ssh-bootstrap.test.ts` | setTimeout(25) 폴링 + 6초 fallback. event-driven 전환 필요, 내부 타이밍 의존도 높음 |

**미처리 — 실 IO, integration 스위트 이전 권고(삭제 아님)**:
| 파일 | 사유 |
|------|------|
| `main/git/git-helpers-ipc.test.ts` | 실제 child process(spawn) + 소켓 프로토콜 e2e. hermetic 불가 |
| `main/git/git-repository-checkout-tracking.test.ts` | execFileSync 실 git 실행 |
| `main/git/git-repository-discard.test.ts` | execFileSync 실 git 실행 |
| `main/agent/runtimeDirs.test.ts` | execSync("bash -n") 케이스만 이전, 나머지 unit 유지 |
| `scripts/claude-wrapper.test.ts` | spawnSync + net.createServer() 실 소켓 |

**미처리 — 0ms setTimeout(실지연 없음, microtask flush, 저우선/무해)**: `main/claude/hook-handler.test.ts`, `main/workspace/browser-closer.test.ts`, `main/workspace/manager-shim-lifecycle.test.ts`, `renderer/ipc/client-stream.test.ts`, `renderer/services/editor/model-entry-didopen-gate.test.ts`, `renderer/state/stores/files/store-query.test.ts`, `renderer/state/stores/workspaces.test.ts`. (실시간 지연이 없어 flaky 위험 낮음 — 정리 우선순위 최하.)

### W3 잔여 (A 매트릭스 파라미터화)

**처리 완료(핫스팟 3)**: `file-icon-resolvers.test.ts`(expect 51 보존), `url-classifier.test.ts`(61 보존), `keybinding-parse.test.ts`(49 보존). 단언이 약해지는 케이스는 억지 통합하지 않고 별도 유지.

**미처리 — 통합 시 단언 약화 위험으로 보류**:
| 파일 | 사유 |
|------|------|
| `renderer/state/stores/files/store-query.test.ts` | tree path 나열형이나 describe가 여러 분기를 섞어 분리 비용 큼 |
| `renderer/state/stores/workspaces.test.ts` | 시나리오별 setup이 달라 단순 test.each 통합 시 억지 통합 |
| `main/ipc/channels/*` | 채널·메서드별 반복이나 각기 다른 Zod 스키마 검증 구조 |
| `renderer/services/editor/model-cache-*.test.ts` | 엣지케이스마다 상태 전제조건이 달라 통합 부적합 |

### W3b 잔여 (B 구현결합)

**처리 완료**: `state/claude-status.test.ts` — ② since 값 단언 재작성(mutation spot-check RED 확인) + ③ EMPTY_TABS 항등 테스트 삭제.

**검토 후 보존 판정(구현결합 아님 — 정당한 계약)**: 표본 검토 결과, 위 (B) 목록의 "`byWorkspace` 직접 접근/참조 동치" 다수는 실제로는 **useSyncExternalStore thrashing 방지용 `return state` 가드 계약**을 검증하는 정당한 행위 테스트였다(SUT에 명시적 가드 존재). 즉 (B) 분류 ~37은 표면 신호 기반 과대추정이며, 개별 판정 시 상당수가 보존 대상이다. 보존 확정: `set-active-group`·`pinned-tab`·`preview-tab`(return-state 가드), `git-operation-lifecycle`·`terminal-services`·`search`·`browser-permissions`·`file-tree-actions`(호출 순서 아닌 인자/결과 내용 단언).

**미처리 — next-cycle 개별 결정트리 판정 대상**: 위 (B) 목록 중 본 사이클에서 개별 판정하지 않은 나머지 파일들(layout/store-structure·store-tab-lifecycle·store-hydration, tabs/store·new-tab-types, files/store-tree-ops·store-hydrate-persist·store-selection, git-decorations, browser-suspend, ui/store, operations/dnd·commit-preview·diff-preview·preview-slot-dirty·tabs-new-types, file-tree-actions-copy-cut·file-tree-click-gestures·file-tree-keyboard-multi·files-panel-refs, bulk-close-cancel·untitled-tab-close, services/editor/close-untitled-with-confirm·open-editor·preview-tab·save-service·open-external-editor, files-panel-reconnect). 각각 §5 결정트리(상위시나리오 중복→삭제 / 구현결합→재작성 / 고유커버리지 판별)로 개별 판정 필요. 표본 결과로 보아 다수는 보존, 일부 mock 순서 결합(예: copy-cut, bulk-close-cancel)은 재작성 후보.

### (R) render() 승격 후보 — next-cycle

위 "(R) render() 권장 후보" 33파일은 본 사이클 범위 밖(렌더러 분류전용 결정). next-cycle에 Testing Library `render()` 기반으로 승격 검토.
