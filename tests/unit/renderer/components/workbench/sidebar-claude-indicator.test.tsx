/**
 * 워크스페이스 카드 상태 칩 렌더 테스트 (sidebar.tsx 내부 WorkspaceRow).
 *
 * useClaudeStatusStore를 모킹해 워크스페이스 집계 상태를 주입한다.
 * renderToStaticMarkup으로 DOM 없이 실행.
 *
 * 기존 ClaudeWorkspaceIndicator (absolute right-20 span)를 제거하고
 * WorkspaceStatusChip (1줄 그리드 인라인 셀)으로 대체한 이후의 테스트.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusEntry } from "../../../../../src/shared/claude/status";
import {
  selectWorkspaceAggregateStatus,
} from "../../../../../src/renderer/state/stores/claude-status";

// ---------------------------------------------------------------------------
// Window IPC stub
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// 주입할 mock 상태 레지스터
// ---------------------------------------------------------------------------

const WS = "ws-sidebar-test";

// 현재 테스트의 tab entries — beforeEach에서 교체한다.
let mockWsTabs: Record<string, StatusEntry> = {};

// ---------------------------------------------------------------------------
// useClaudeStatusStore mock — selectWorkspaceAggregateStatus는 실제 구현 사용
// ---------------------------------------------------------------------------

mock.module("../../../../../src/renderer/state/stores/claude-status", () => {
  return {
    useClaudeStatusStore: (selector: (s: { byWorkspace: Record<string, Record<string, StatusEntry>> }) => unknown) => {
      const fakeState = { byWorkspace: { [WS]: mockWsTabs } };
      if (typeof selector === "function") return selector(fakeState);
      return fakeState;
    },
    selectWorkspaceAggregateStatus,
    selectStatusForTab: (
      state: { byWorkspace: Record<string, Record<string, StatusEntry>> },
      workspaceId: string,
      tabId: string,
    ) => state.byWorkspace[workspaceId]?.[tabId],
    selectIsWorkspaceAttention: () => false,
    EMPTY_TABS: {},
    ATTENTION_STATUSES: ["needsInput", "permissionPending", "error"],
    WORKSPACE_VISIBLE_STATUSES: ["running", "completed", "needsInput", "permissionPending", "error"],
    isAttentionRequired: (s: unknown) =>
      s !== undefined && ["needsInput", "permissionPending", "error"].includes(s as string),
  };
});

// ---------------------------------------------------------------------------
// Import after mock
// ---------------------------------------------------------------------------

const { Sidebar } = await import("../../../../../src/renderer/components/workbench/sidebar");
const { useUIStore } = await import("../../../../../src/renderer/state/stores/ui");
const { useWorkspacesStore } = await import(
  "../../../../../src/renderer/state/stores/workspaces"
);

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function makeEntry(tabId: string, status: StatusEntry["status"]): StatusEntry {
  return { workspaceId: WS, tabId, status, since: 1000000 };
}

function resetAll() {
  useUIStore.setState({ sidebarWidth: 240 });
  useWorkspacesStore.setState({ workspaces: [], connectionStatusByWorkspaceId: {} });
  mockWsTabs = {};
}

/** Sidebar를 로컬 워크스페이스 1개로 렌더해 HTML을 반환한다. */
function renderSidebarForWs(): string {
  return renderToStaticMarkup(
    <Sidebar
      workspaces={[
        {
          id: WS,
          name: "test-ws",
          rootPath: "/tmp/test",
          colorTone: "default",
          pinned: false,
          lastOpenedAt: new Date().toISOString(),
          tabs: [],
          location: { kind: "local", rootPath: "/tmp/test" },
        },
      ]}
      activeWorkspaceId={WS}
      onSelectWorkspace={() => {}}
      onAddWorkspace={() => {}}
      onRemoveWorkspace={() => {}}
    />,
  );
}

// ---------------------------------------------------------------------------
// running-only — 칩 렌더 (running은 WORKSPACE_VISIBLE_STATUSES에 포함)
// ---------------------------------------------------------------------------

describe("WorkspaceStatusChip — running-only 워크스페이스", () => {
  beforeEach(resetAll);

  test("running 탭이 있으면 'Claude: running' aria-label이 렌더된다", () => {
    mockWsTabs = { t1: makeEntry("t1", "running") };
    const html = renderSidebarForWs();
    expect(html).toContain("Claude: running");
  });
});

// ---------------------------------------------------------------------------
// needsInput — 칩 렌더 + aria-label
// ---------------------------------------------------------------------------

describe("WorkspaceStatusChip — needsInput", () => {
  beforeEach(resetAll);

  test("needsInput 탭이 있으면 'Claude: waiting for input' aria-label이 렌더된다", () => {
    mockWsTabs = { t1: makeEntry("t1", "needsInput") };
    const html = renderSidebarForWs();
    expect(html).toContain("Claude: waiting for input");
  });

  test("tab-claude-attention-fg 토큰 클래스가 적용된다", () => {
    mockWsTabs = { t1: makeEntry("t1", "needsInput") };
    const html = renderSidebarForWs();
    expect(html).toContain("tab-claude-attention-fg");
  });
});

// ---------------------------------------------------------------------------
// permissionPending — 최고 우선순위
// ---------------------------------------------------------------------------

describe("WorkspaceStatusChip — permissionPending 우선순위", () => {
  beforeEach(resetAll);

  test("permissionPending + needsInput 혼합 시 state-warning-fg(permissionPending 우선)가 사용된다", () => {
    mockWsTabs = {
      t1: makeEntry("t1", "permissionPending"),
      t2: makeEntry("t2", "needsInput"),
    };
    const html = renderSidebarForWs();
    expect(html).toContain("state-warning-fg");
    expect(html).toContain("Claude: waiting for permission");
  });
});

// ---------------------------------------------------------------------------
// error — state-error-fg
// ---------------------------------------------------------------------------

describe("WorkspaceStatusChip — error", () => {
  beforeEach(resetAll);

  test("error 탭이 있으면 state-error-fg 토큰 클래스가 적용된다", () => {
    mockWsTabs = { t1: makeEntry("t1", "error") };
    const html = renderSidebarForWs();
    expect(html).toContain("state-error-fg");
  });

  test("error > needsInput 우선순위: error 탭 있을 때 state-error-fg 사용", () => {
    mockWsTabs = {
      t1: makeEntry("t1", "needsInput"),
      t2: makeEntry("t2", "error"),
    };
    const html = renderSidebarForWs();
    expect(html).toContain("state-error-fg");
  });
});

// ---------------------------------------------------------------------------
// 카운트 표시 — attention count >= 2 이면 숫자 표시
// ---------------------------------------------------------------------------

describe("WorkspaceStatusChip — 카운트 표시", () => {
  beforeEach(resetAll);

  test("attention 탭이 1개이면 'Input' 레이블이 렌더된다(숫자 없음)", () => {
    mockWsTabs = { t1: makeEntry("t1", "needsInput") };
    const html = renderSidebarForWs();
    // count=1이면 레이블('Input')이 표시되고 숫자 >1<는 없다.
    expect(html).toContain(">Input<");
    expect(html).not.toContain(">1<");
  });

  test("attention 탭이 2개이면 숫자 '2'가 렌더된다", () => {
    mockWsTabs = {
      t1: makeEntry("t1", "needsInput"),
      t2: makeEntry("t2", "error"),
    };
    const html = renderSidebarForWs();
    expect(html).toContain(">2<");
  });

  test("attention 탭이 3개이면 숫자 '3'이 렌더된다", () => {
    mockWsTabs = {
      t1: makeEntry("t1", "needsInput"),
      t2: makeEntry("t2", "error"),
      t3: makeEntry("t3", "permissionPending"),
    };
    const html = renderSidebarForWs();
    expect(html).toContain(">3<");
  });
});

// ---------------------------------------------------------------------------
// 상태 없음 (idle)
// ---------------------------------------------------------------------------

describe("WorkspaceStatusChip — 상태 없음", () => {
  beforeEach(resetAll);

  test("Claude 상태가 없으면 칩이 렌더되지 않는다", () => {
    const html = renderSidebarForWs();
    // 칩의 role="status"가 없어야 한다.
    expect(html).not.toContain("Claude: waiting for input");
    expect(html).not.toContain("Claude: running");
    expect(html).not.toContain("Claude: error");
  });
});

// ---------------------------------------------------------------------------
// SSH dot과 형태 분리
// ---------------------------------------------------------------------------

describe("WorkspaceStatusChip — SSH dot과 형태 분리", () => {
  beforeEach(resetAll);

  test("Claude 칩은 rounded-full dot 형태를 사용하지 않는다(local WS)", () => {
    mockWsTabs = { t1: makeEntry("t1", "needsInput") };
    const html = renderSidebarForWs();
    // local 워크스페이스에는 SSH dot이 없고 claude 칩도 외곽선 글리프.
    expect(html).not.toContain("rounded-full");
  });
});
