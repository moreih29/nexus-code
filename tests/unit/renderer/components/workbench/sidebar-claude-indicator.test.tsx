/**
 * 워크스페이스 카드 상태 글리프 렌더 테스트 (sidebar.tsx 내부 WorkspaceRow).
 *
 * useClaudeStatusStore를 모킹해 워크스페이스 집계 상태를 주입한다.
 * renderToStaticMarkup으로 DOM 없이 실행.
 *
 * 칩(레이블 + 배경) → 글리프(아이콘만)로 변경된 이후의 테스트.
 * 글리프는 ssh/local 아이콘(16px) 셀 아래에 12px 글리프로 렌더된다.
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
    WORKSPACE_VISIBLE_STATUSES: [
      "idle",
      "running",
      "completed",
      "needsInput",
      "permissionPending",
      "error",
    ],
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
// idle — 회색 글리프 (사용자 확인 완료 dim 상태)
// ---------------------------------------------------------------------------

describe("WorkspaceStatusGlyph — idle", () => {
  beforeEach(resetAll);

  test("idle 탭이 있으면 'Claude: idle' aria-label이 렌더된다", () => {
    mockWsTabs = { t1: makeEntry("t1", "idle") };
    const html = renderSidebarForWs();
    expect(html).toContain("Claude: idle");
  });

  test("idle 글리프는 muted-foreground 색 클래스를 사용한다", () => {
    mockWsTabs = { t1: makeEntry("t1", "idle") };
    const html = renderSidebarForWs();
    expect(html).toContain("text-muted-foreground");
  });
});

// ---------------------------------------------------------------------------
// running — 초록 글리프 + animate-spin
// ---------------------------------------------------------------------------

describe("WorkspaceStatusGlyph — running", () => {
  beforeEach(resetAll);

  test("running 탭이 있으면 'Claude: running' aria-label이 렌더된다", () => {
    mockWsTabs = { t1: makeEntry("t1", "running") };
    const html = renderSidebarForWs();
    expect(html).toContain("Claude: running");
  });

  test("running 글리프는 emerald-500 색 + animate-spin 클래스를 사용한다", () => {
    mockWsTabs = { t1: makeEntry("t1", "running") };
    const html = renderSidebarForWs();
    expect(html).toContain("text-emerald-500");
    expect(html).toContain("motion-safe:animate-spin");
  });
});

// ---------------------------------------------------------------------------
// completed — 파란 체크 (응답 종료, 사용자 미확인)
// ---------------------------------------------------------------------------

describe("WorkspaceStatusGlyph — completed", () => {
  beforeEach(resetAll);

  test("completed 탭이 있으면 'response complete' aria-label이 렌더된다", () => {
    mockWsTabs = { t1: makeEntry("t1", "completed") };
    const html = renderSidebarForWs();
    expect(html).toContain("Claude: response complete");
  });

  test("completed 글리프는 tab-claude-attention-fg 토큰을 사용한다", () => {
    mockWsTabs = { t1: makeEntry("t1", "completed") };
    const html = renderSidebarForWs();
    expect(html).toContain("tab-claude-attention-fg");
  });
});

// ---------------------------------------------------------------------------
// needsInput
// ---------------------------------------------------------------------------

describe("WorkspaceStatusGlyph — needsInput", () => {
  beforeEach(resetAll);

  test("needsInput 탭이 있으면 'waiting for input' aria-label이 렌더된다", () => {
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

describe("WorkspaceStatusGlyph — permissionPending 우선순위", () => {
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

describe("WorkspaceStatusGlyph — error", () => {
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
// 상태 없음 (StatusEntry 자체가 없는 워크스페이스)
// ---------------------------------------------------------------------------

describe("WorkspaceStatusGlyph — StatusEntry 없음", () => {
  beforeEach(resetAll);

  test("Claude StatusEntry가 없으면 글리프가 렌더되지 않는다", () => {
    // mockWsTabs는 {} 그대로 — wsTabs는 키 존재하나 entries.length === 0이라 aggregate null.
    const html = renderSidebarForWs();
    expect(html).not.toContain("Claude: waiting for input");
    expect(html).not.toContain("Claude: running");
    expect(html).not.toContain("Claude: idle");
    expect(html).not.toContain("Claude: error");
  });
});

// ---------------------------------------------------------------------------
// 형태 — 글리프만, 레이블·배경·카운트 없음
// ---------------------------------------------------------------------------

describe("WorkspaceStatusGlyph — 형태", () => {
  beforeEach(resetAll);

  test("글리프는 레이블(Running/Input 등) 텍스트를 포함하지 않는다", () => {
    mockWsTabs = { t1: makeEntry("t1", "running") };
    const html = renderSidebarForWs();
    expect(html).not.toContain(">Running<");
    expect(html).not.toContain(">Input<");
    expect(html).not.toContain(">Done<");
  });

  test("글리프는 배경 칩 클래스(rounded-full / px-1.5 / bg-...)를 사용하지 않는다", () => {
    mockWsTabs = { t1: makeEntry("t1", "needsInput") };
    const html = renderSidebarForWs();
    // 글리프 자체에 rounded-full / px-1.5 / 배경 색 클래스가 없어야 한다.
    // (단, 다른 사이드바 요소가 rounded-full을 쓸 수 있으니 px-1.5 + h-5만 검증)
    expect(html).not.toContain("px-1.5");
    expect(html).not.toContain("h-5 rounded");
  });
});
