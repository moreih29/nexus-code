import { create } from "zustand";

/**
 * 탭 이름 inline 편집 모드의 활성 tab id를 관리하는 store.
 *
 * 의도된 단일성: 한 번에 한 탭만 편집 중. 다른 탭의 편집을 startEditing으로
 * 시작하면 이전 탭은 자동으로 cancel된다 (시각적으로도 한 탭의 input만 활성).
 *
 * 이 store를 별도 모듈로 분리한 이유:
 *   - 컨텍스트 메뉴(GroupTabBar)와 더블클릭(TabItem) 두 진입점이 동일한 상태를
 *     공유해야 한다. props로 흘리려면 TabBar까지 drilling이 깊고 contextTabId와
 *     editingTabId가 mix되어 부모 컴포넌트 책임이 늘어난다.
 *   - useTabsStore 안에 두지 않은 이유는 편집 상태가 데이터 모델이 아니라
 *     UI 인터랙션 상태이기 때문. 워크스페이스 정리 시점에도 별도 관리 불필요.
 */
interface TabEditingState {
  /** 현재 inline 편집 중인 tab id. 없으면 null. */
  editingTabId: string | null;
  /** 해당 tab의 inline input을 활성화한다. */
  startEditing(tabId: string): void;
  /** 편집 모드를 종료한다. commit / cancel 모두 이 함수로 정리한다. */
  cancelEditing(): void;
}

export const useTabEditingStore = create<TabEditingState>((set) => ({
  editingTabId: null,
  startEditing(tabId) {
    set({ editingTabId: tabId });
  },
  cancelEditing() {
    set({ editingTabId: null });
  },
}));
