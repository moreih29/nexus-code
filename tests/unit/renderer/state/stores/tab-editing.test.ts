/**
 * useTabEditingStore 단위 테스트.
 *
 * - startEditing / cancelEditing 기본 동작
 * - 단일성: 다른 탭의 startEditing이 이전 탭을 자동으로 대체
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { useTabEditingStore } from "../../../../../src/renderer/state/stores/tab-editing";

function resetStore() {
  useTabEditingStore.setState({ editingTabId: null });
}

describe("useTabEditingStore", () => {
  beforeEach(resetStore);

  test("초기 editingTabId는 null", () => {
    expect(useTabEditingStore.getState().editingTabId).toBeNull();
  });

  test("startEditing이 editingTabId를 설정", () => {
    useTabEditingStore.getState().startEditing("tab-a");
    expect(useTabEditingStore.getState().editingTabId).toBe("tab-a");
  });

  test("cancelEditing이 editingTabId를 null로 reset", () => {
    useTabEditingStore.getState().startEditing("tab-a");
    useTabEditingStore.getState().cancelEditing();
    expect(useTabEditingStore.getState().editingTabId).toBeNull();
  });

  test("단일성 — 다른 탭의 startEditing이 이전 탭을 대체", () => {
    useTabEditingStore.getState().startEditing("tab-a");
    useTabEditingStore.getState().startEditing("tab-b");
    expect(useTabEditingStore.getState().editingTabId).toBe("tab-b");
  });
});
