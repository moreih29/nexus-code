import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// 최소 shim — zustand가 bun 환경에서 구동되려면 window.ipc가 있어야 한다.
// registerWorkspaceCleanup은 window.ipc 없이도 동작하지만,
// workspace-cleanup.ts 가 ipcListen을 import하므로 shim이 필요하다.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Store import (shim 이후)
// ---------------------------------------------------------------------------

import {
  ATTENTION_STATUSES,
  EMPTY_TABS,
  isAttentionRequired,
  selectIsWorkspaceAttention,
  selectStatusForTab,
  selectWorkspaceAggregateStatus,
  useClaudeStatusStore,
} from "../../../../src/renderer/state/stores/claude-status";
import type { StatusEntry } from "../../../../src/shared/claude/status";

// ---------------------------------------------------------------------------
// 테스트용 fixture 헬퍼
// ---------------------------------------------------------------------------

const WS_A = "ws-aaaa";
const WS_B = "ws-bbbb";
const TAB_1 = "tab-0001";
const TAB_2 = "tab-0002";
const TAB_3 = "tab-0003";

function makeEntry(
  workspaceId: string,
  tabId: string,
  status: StatusEntry["status"],
  overrides: Partial<StatusEntry> = {},
): StatusEntry {
  return {
    workspaceId,
    tabId,
    status,
    since: 1000000,
    ...overrides,
  };
}

function reset() {
  useClaudeStatusStore.setState({ byWorkspace: {} });
}

// ---------------------------------------------------------------------------
// setMany — byWorkspace 전체 교체
// ---------------------------------------------------------------------------

describe("useClaudeStatusStore — setMany", () => {
  beforeEach(reset);

  it("단일 entry로 byWorkspace를 초기화한다", () => {
    const entry = makeEntry(WS_A, TAB_1, "running");
    useClaudeStatusStore.getState().setMany([entry]);
    const state = useClaudeStatusStore.getState();
    expect(state.byWorkspace[WS_A]?.[TAB_1]).toEqual(entry);
  });

  it("여러 워크스페이스·탭 entry를 중첩 record로 매핑한다", () => {
    const e1 = makeEntry(WS_A, TAB_1, "running");
    const e2 = makeEntry(WS_A, TAB_2, "idle");
    const e3 = makeEntry(WS_B, TAB_1, "needsInput");
    useClaudeStatusStore.getState().setMany([e1, e2, e3]);

    const state = useClaudeStatusStore.getState();
    expect(state.byWorkspace[WS_A]?.[TAB_1]).toEqual(e1);
    expect(state.byWorkspace[WS_A]?.[TAB_2]).toEqual(e2);
    expect(state.byWorkspace[WS_B]?.[TAB_1]).toEqual(e3);
  });

  it("새 snapshot에 없는 이전 워크스페이스 entry를 제거한다", () => {
    useClaudeStatusStore.getState().setMany([makeEntry(WS_A, TAB_1, "running")]);
    // WS_A 없는 새 snapshot으로 교체
    useClaudeStatusStore.getState().setMany([makeEntry(WS_B, TAB_1, "idle")]);

    const state = useClaudeStatusStore.getState();
    expect(state.byWorkspace[WS_A]).toBeUndefined();
    expect(state.byWorkspace[WS_B]?.[TAB_1]).toBeDefined();
  });

  it("빈 배열이면 byWorkspace가 빈 record가 된다", () => {
    useClaudeStatusStore.getState().setMany([makeEntry(WS_A, TAB_1, "running")]);
    useClaudeStatusStore.getState().setMany([]);

    const state = useClaudeStatusStore.getState();
    expect(state.byWorkspace).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// set — identity 유지 (useSyncExternalStore 안전)
// ---------------------------------------------------------------------------

describe("useClaudeStatusStore — set identity stability", () => {
  beforeEach(reset);

  it("동일 값 재set 시 byWorkspace 참조가 변경되지 않는다", () => {
    const entry = makeEntry(WS_A, TAB_1, "running");
    useClaudeStatusStore.getState().set(entry);
    const before = useClaudeStatusStore.getState().byWorkspace;

    // 동일한 status/message/since로 다시 set
    useClaudeStatusStore.getState().set({ ...entry });
    const after = useClaudeStatusStore.getState().byWorkspace;

    expect(after).toBe(before);
  });

  it("status가 변경되면 byWorkspace 참조가 교체된다", () => {
    const entry = makeEntry(WS_A, TAB_1, "running");
    useClaudeStatusStore.getState().set(entry);
    const before = useClaudeStatusStore.getState().byWorkspace;

    useClaudeStatusStore.getState().set({ ...entry, status: "idle" });
    const after = useClaudeStatusStore.getState().byWorkspace;

    expect(after).not.toBe(before);
    expect(after[WS_A]?.[TAB_1]?.status).toBe("idle");
  });

  it("message가 추가되면 entry가 갱신된다", () => {
    const entry = makeEntry(WS_A, TAB_1, "running");
    useClaudeStatusStore.getState().set(entry);

    const withMessage = { ...entry, message: "Processing…" };
    useClaudeStatusStore.getState().set(withMessage);

    expect(useClaudeStatusStore.getState().byWorkspace[WS_A]?.[TAB_1]?.message).toBe(
      "Processing…",
    );
  });

  it("since가 변경되면 entry가 갱신된다", () => {
    const entry = makeEntry(WS_A, TAB_1, "running");
    useClaudeStatusStore.getState().set(entry);
    const before = useClaudeStatusStore.getState().byWorkspace;

    useClaudeStatusStore.getState().set({ ...entry, since: entry.since + 1 });
    const after = useClaudeStatusStore.getState().byWorkspace;

    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// clearWorkspace
// ---------------------------------------------------------------------------

describe("useClaudeStatusStore — clearWorkspace", () => {
  beforeEach(reset);

  it("해당 workspaceId의 모든 entry가 제거된다", () => {
    useClaudeStatusStore.getState().setMany([
      makeEntry(WS_A, TAB_1, "running"),
      makeEntry(WS_A, TAB_2, "idle"),
      makeEntry(WS_B, TAB_1, "needsInput"),
    ]);

    useClaudeStatusStore.getState().clearWorkspace(WS_A);

    const state = useClaudeStatusStore.getState();
    expect(state.byWorkspace[WS_A]).toBeUndefined();
    // 다른 워크스페이스는 영향 없다.
    expect(state.byWorkspace[WS_B]?.[TAB_1]).toBeDefined();
  });

  it("존재하지 않는 workspaceId는 state identity를 유지한다", () => {
    useClaudeStatusStore.getState().setMany([makeEntry(WS_A, TAB_1, "running")]);
    const before = useClaudeStatusStore.getState().byWorkspace;

    useClaudeStatusStore.getState().clearWorkspace(WS_B);
    const after = useClaudeStatusStore.getState().byWorkspace;

    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// selectWorkspaceAggregateStatus — 우선순위
// ---------------------------------------------------------------------------

describe("selectWorkspaceAggregateStatus", () => {
  beforeEach(reset);

  it("워크스페이스가 없으면 null을 반환한다", () => {
    const state = useClaudeStatusStore.getState();
    expect(selectWorkspaceAggregateStatus(state, WS_A)).toBeNull();
  });

  it("entry가 하나도 없는 빈 record이면 null을 반환한다", () => {
    // 직접 빈 record 주입
    useClaudeStatusStore.setState({ byWorkspace: { [WS_A]: {} } });
    const state = useClaudeStatusStore.getState();
    expect(selectWorkspaceAggregateStatus(state, WS_A)).toBeNull();
  });

  it("idle만 있으면 status=idle, count=0을 반환한다", () => {
    useClaudeStatusStore.getState().setMany([makeEntry(WS_A, TAB_1, "idle")]);
    const state = useClaudeStatusStore.getState();
    const result = selectWorkspaceAggregateStatus(state, WS_A);
    expect(result?.status).toBe("idle");
    expect(result?.count).toBe(0);
  });

  it("running이 포함되면 status=running을 반환한다", () => {
    useClaudeStatusStore.getState().setMany([
      makeEntry(WS_A, TAB_1, "idle"),
      makeEntry(WS_A, TAB_2, "running"),
    ]);
    const state = useClaudeStatusStore.getState();
    expect(selectWorkspaceAggregateStatus(state, WS_A)?.status).toBe("running");
  });

  it("needsInput이 running보다 우선한다", () => {
    useClaudeStatusStore.getState().setMany([
      makeEntry(WS_A, TAB_1, "running"),
      makeEntry(WS_A, TAB_2, "needsInput"),
    ]);
    const state = useClaudeStatusStore.getState();
    const result = selectWorkspaceAggregateStatus(state, WS_A);
    expect(result?.status).toBe("needsInput");
    expect(result?.count).toBe(1);
  });

  it("error가 needsInput보다 우선한다", () => {
    useClaudeStatusStore.getState().setMany([
      makeEntry(WS_A, TAB_1, "needsInput"),
      makeEntry(WS_A, TAB_2, "error"),
    ]);
    const state = useClaudeStatusStore.getState();
    expect(selectWorkspaceAggregateStatus(state, WS_A)?.status).toBe("error");
  });

  it("permissionPending이 최고 우선순위이다", () => {
    useClaudeStatusStore.getState().setMany([
      makeEntry(WS_A, TAB_1, "idle"),
      makeEntry(WS_A, TAB_2, "running"),
      makeEntry(WS_A, TAB_3, "needsInput"),
      makeEntry(WS_B, TAB_1, "error"),
    ]);
    // WS_B에 permissionPending 추가
    useClaudeStatusStore.getState().set(makeEntry(WS_A, "tab-perm", "permissionPending"));
    const state = useClaudeStatusStore.getState();
    const result = selectWorkspaceAggregateStatus(state, WS_A);
    expect(result?.status).toBe("permissionPending");
  });

  it("5상태 mix — permissionPending > error > needsInput > running > idle 순서", () => {
    // 모든 5가지 상태가 동시에 있는 경우 permissionPending이 이긴다.
    useClaudeStatusStore.getState().setMany([
      makeEntry(WS_A, "t-idle", "idle"),
      makeEntry(WS_A, "t-run", "running"),
      makeEntry(WS_A, "t-ni", "needsInput"),
      makeEntry(WS_A, "t-err", "error"),
      makeEntry(WS_A, "t-pp", "permissionPending"),
    ]);
    const state = useClaudeStatusStore.getState();
    const result = selectWorkspaceAggregateStatus(state, WS_A);
    expect(result?.status).toBe("permissionPending");
    // needsInput + error + permissionPending = 3 attention 탭
    expect(result?.count).toBe(3);
  });

  it("count는 needsInput|error|permissionPending 탭 수만 센다", () => {
    useClaudeStatusStore.getState().setMany([
      makeEntry(WS_A, TAB_1, "idle"),
      makeEntry(WS_A, TAB_2, "running"),
      makeEntry(WS_A, TAB_3, "needsInput"),
    ]);
    const state = useClaudeStatusStore.getState();
    expect(selectWorkspaceAggregateStatus(state, WS_A)?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// selectStatusForTab
// ---------------------------------------------------------------------------

describe("selectStatusForTab", () => {
  beforeEach(reset);

  it("존재하는 entry를 반환한다", () => {
    const entry = makeEntry(WS_A, TAB_1, "running");
    useClaudeStatusStore.getState().set(entry);
    const state = useClaudeStatusStore.getState();
    expect(selectStatusForTab(state, WS_A, TAB_1)).toEqual(entry);
  });

  it("존재하지 않는 탭은 undefined를 반환한다", () => {
    const state = useClaudeStatusStore.getState();
    expect(selectStatusForTab(state, WS_A, "nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selectIsWorkspaceAttention
// ---------------------------------------------------------------------------

describe("selectIsWorkspaceAttention", () => {
  beforeEach(reset);

  it("idle/running만 있으면 false를 반환한다", () => {
    useClaudeStatusStore.getState().setMany([
      makeEntry(WS_A, TAB_1, "idle"),
      makeEntry(WS_A, TAB_2, "running"),
    ]);
    const state = useClaudeStatusStore.getState();
    expect(selectIsWorkspaceAttention(state, WS_A)).toBe(false);
  });

  it("needsInput 탭이 있으면 true를 반환한다", () => {
    useClaudeStatusStore.getState().setMany([makeEntry(WS_A, TAB_1, "needsInput")]);
    const state = useClaudeStatusStore.getState();
    expect(selectIsWorkspaceAttention(state, WS_A)).toBe(true);
  });

  it("permissionPending 탭이 있으면 true를 반환한다", () => {
    useClaudeStatusStore.getState().setMany([makeEntry(WS_A, TAB_1, "permissionPending")]);
    const state = useClaudeStatusStore.getState();
    expect(selectIsWorkspaceAttention(state, WS_A)).toBe(true);
  });

  it("error 탭이 있으면 true를 반환한다", () => {
    useClaudeStatusStore.getState().setMany([makeEntry(WS_A, TAB_1, "error")]);
    const state = useClaudeStatusStore.getState();
    expect(selectIsWorkspaceAttention(state, WS_A)).toBe(true);
  });

  it("워크스페이스가 없으면 false를 반환한다", () => {
    const state = useClaudeStatusStore.getState();
    expect(selectIsWorkspaceAttention(state, "nonexistent-ws")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAttentionRequired helper
// ---------------------------------------------------------------------------

describe("isAttentionRequired", () => {
  it("undefined이면 false를 반환한다", () => {
    expect(isAttentionRequired(undefined)).toBe(false);
  });

  it("idle이면 false를 반환한다", () => {
    expect(isAttentionRequired("idle")).toBe(false);
  });

  it("running이면 false를 반환한다", () => {
    expect(isAttentionRequired("running")).toBe(false);
  });

  it("needsInput이면 true를 반환한다", () => {
    expect(isAttentionRequired("needsInput")).toBe(true);
  });

  it("permissionPending이면 true를 반환한다", () => {
    expect(isAttentionRequired("permissionPending")).toBe(true);
  });

  it("error이면 true를 반환한다", () => {
    expect(isAttentionRequired("error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ATTENTION_STATUSES export
// ---------------------------------------------------------------------------

describe("ATTENTION_STATUSES", () => {
  it("needsInput, permissionPending, error를 포함한다", () => {
    expect(ATTENTION_STATUSES).toContain("needsInput");
    expect(ATTENTION_STATUSES).toContain("permissionPending");
    expect(ATTENTION_STATUSES).toContain("error");
    expect(ATTENTION_STATUSES).not.toContain("idle");
    expect(ATTENTION_STATUSES).not.toContain("running");
  });
});

// ---------------------------------------------------------------------------
// EMPTY_TABS 모듈 상수 identity 확인
// ---------------------------------------------------------------------------

describe("EMPTY_TABS", () => {
  it("동일 참조를 반복 접근해도 identity가 유지된다", () => {
    expect(EMPTY_TABS).toBe(EMPTY_TABS);
  });
});
