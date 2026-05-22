/**
 * Claude 상태 인디케이터 — TabItem 렌더 테스트.
 *
 * useClaudeStatusStore를 모킹해 컴포넌트에 상태를 주입한다.
 * renderToStaticMarkup으로 DOM 없이 실행.
 *
 * 테스트 전략:
 * - 5상태별 글리프 aria-label, CSS 토큰 class 존재를 검증한다.
 * - attention bar (rounded-none + 상태별 색 토큰) 렌더 여부를 검증한다.
 * - a11y: aria-label 존재 검증.
 *
 * NOTE: mock.module로 useClaudeStatusStore를 완전 교체해 모듈 인스턴스 공유 문제를 회피한다.
 * bun의 mock.module은 모든 import에 걸쳐 동일 mock을 공유하므로 컴포넌트가 보는
 * useClaudeStatusStore와 테스트가 제어하는 값이 같은 소스에서 온다.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import type { EditorTab } from "../../../../../../src/renderer/state/stores/tabs";
import type { ClaudeStatus, StatusEntry } from "../../../../../../src/shared/claude/status";

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
// mock으로 주입할 현재 상태를 제어하는 레지스터
// ---------------------------------------------------------------------------

// 테스트가 쓰는 레지스터: beforeEach에서 교체한다.
let currentClaudeStatus: ClaudeStatus | undefined = undefined;

const WS = "ws-test";
const TAB = "tab-test";

// ---------------------------------------------------------------------------
// useClaudeStatusStore mock — 컴포넌트가 import하는 경로와 동일하게 등록
// ---------------------------------------------------------------------------

mock.module("../../../../../../src/renderer/state/stores/claude-status", () => {
  // selectStatusForTab 은 mock 함수에서 직접 구현한다.
  // ATTENTION_STATUSES / isAttentionRequired / EMPTY_TABS 는 컴포넌트가 사용하지
  // 않으므로 간단히 패스스루 값만 제공한다.
  return {
    useClaudeStatusStore: (selector: (s: { byWorkspace: Record<string, Record<string, StatusEntry>> }) => unknown) => {
      // selector 호출 시뮬레이션 — 현재 mock 상태를 반영한다.
      const fakeState = {
        byWorkspace: currentClaudeStatus !== undefined && currentClaudeStatus !== "idle"
          ? {
              [WS]: {
                [TAB]: { workspaceId: WS, tabId: TAB, status: currentClaudeStatus, since: 1000000 },
              },
            }
          : currentClaudeStatus === "idle"
            ? {
                [WS]: {
                  [TAB]: { workspaceId: WS, tabId: TAB, status: "idle" as ClaudeStatus, since: 1000000 },
                },
              }
            : {},
        setMany: () => {},
        set: () => {},
        clearTab: () => {},
        clearWorkspace: () => {},
      };
      if (typeof selector === "function") return selector(fakeState);
      return fakeState;
    },
    selectStatusForTab: (
      state: { byWorkspace: Record<string, Record<string, StatusEntry>> },
      workspaceId: string,
      tabId: string,
    ) => state.byWorkspace[workspaceId]?.[tabId],
    EMPTY_TABS: {},
    ATTENTION_STATUSES: ["needsInput", "permissionPending", "error"],
    isAttentionRequired: (s: ClaudeStatus | undefined) =>
      s !== undefined && ["needsInput", "permissionPending", "error"].includes(s),
    selectWorkspaceAggregateStatus: () => null,
    selectIsWorkspaceAttention: () => false,
  };
});

// ---------------------------------------------------------------------------
// Editor + drag mock
// ---------------------------------------------------------------------------

mock.module("../../../../../../src/renderer/services/editor", () => ({
  useSharedModel: () => ({ model: null, phase: "loading", readOnly: false, errorCode: undefined }),
  filePathToModelUri: (p: string) => `file://${p}`,
  isDirty: () => false,
  subscribeFileDirty: () => () => {},
  openOrRevealEditor: () => null,
  closeEditor: () => {},
  closeEditorWithConfirm: async () => "closed",
  saveModel: async () => ({ kind: "ok" }),
  cacheUriToFilePath: (uri: string) => uri.replace("file://", ""),
  findEditorTab: () => null,
  findEditorTabInGroup: () => null,
  findPreviewTabInGroup: () => null,
  PREVIEW_ENABLED: true,
  initializeEditorServices: () => {},
}));

mock.module("../../../../../../src/renderer/components/ui/use-drag-source", () => ({
  useDragSource: () => ({ onDragStart: () => {} }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { TabItem } = await import(
  "../../../../../../src/renderer/components/workspace/tabs/tab-item"
);

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function makeEditorTab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: TAB,
    title: "index.ts",
    isPreview: false,
    isPinned: false,
    type: "editor",
    props: { workspaceId: WS, filePath: "/workspace/src/index.ts" },
    ...overrides,
  };
}

/**
 * TabItem을 Radix Tabs 컨텍스트 안에서 렌더해 HTML 문자열을 반환한다.
 */
function renderTabItem(overrides: Partial<EditorTab> = {}): string {
  return renderToStaticMarkup(
    <RadixTooltip.Provider>
      <RadixTabs.Root value={TAB}>
        <RadixTabs.List>
          <TabItem
            workspaceId={WS}
            leafId="leaf-1"
            tab={makeEditorTab(overrides)}
            displayTitle="index.ts"
            onCloseTab={() => {}}
          />
        </RadixTabs.List>
      </RadixTabs.Root>
    </RadixTooltip.Provider>,
  );
}

// ---------------------------------------------------------------------------
// idle — 글리프 슬롯 미렌더
// ---------------------------------------------------------------------------

describe("TabItem — idle 상태", () => {
  beforeEach(() => {
    currentClaudeStatus = "idle";
  });

  test("Claude 관련 aria-label이 렌더되지 않는다", () => {
    const html = renderTabItem();
    expect(html).not.toContain("Claude:");
  });
});

// ---------------------------------------------------------------------------
// running — Loader 글리프 + state.loading.indicator 토큰
// ---------------------------------------------------------------------------

describe("TabItem — running 상태", () => {
  beforeEach(() => {
    currentClaudeStatus = "running";
  });

  test("aria-label='Claude: running'이 렌더된다", () => {
    const html = renderTabItem();
    expect(html).toContain("Claude: running");
  });

  test("state-loading-indicator 토큰 클래스가 적용된다", () => {
    const html = renderTabItem();
    expect(html).toContain("state-loading-indicator");
  });

  test("attention bar(rounded-none)가 없다 — running은 bar 미표시", () => {
    const html = renderTabItem();
    expect(html).not.toContain("rounded-none");
  });

  test("Loader 글리프에 animate-spin 클래스가 포함된다", () => {
    const html = renderTabItem();
    expect(html).toContain("animate-spin");
  });
});

// ---------------------------------------------------------------------------
// needsInput — CircleDot + tab.claude.attention.fg (attention bar 제거됨)
// ---------------------------------------------------------------------------

describe("TabItem — needsInput 상태", () => {
  beforeEach(() => {
    currentClaudeStatus = "needsInput";
  });

  test("aria-label='Claude: waiting for input'이 렌더된다", () => {
    const html = renderTabItem();
    expect(html).toContain("Claude: waiting for input");
  });

  test("tab-claude-attention-fg 토큰 클래스가 적용된다", () => {
    const html = renderTabItem();
    expect(html).toContain("tab-claude-attention-fg");
  });

  test("좌측 attention bar(rounded-none)가 없다 — bar 제거됨", () => {
    const html = renderTabItem();
    expect(html).not.toContain("rounded-none");
  });
});

// ---------------------------------------------------------------------------
// permissionPending — CircleAlert + state.warning.fg + tint (attention bar 제거됨)
// ---------------------------------------------------------------------------

describe("TabItem — permissionPending 상태", () => {
  beforeEach(() => {
    currentClaudeStatus = "permissionPending";
  });

  test("aria-label='Claude: waiting for permission'이 렌더된다", () => {
    const html = renderTabItem();
    expect(html).toContain("Claude: waiting for permission");
  });

  test("state-warning-fg 토큰 클래스가 적용된다", () => {
    const html = renderTabItem();
    expect(html).toContain("state-warning-fg");
  });

  test("좌측 attention bar(rounded-none)가 없다 — bar 제거됨", () => {
    const html = renderTabItem();
    expect(html).not.toContain("rounded-none");
  });

  test("배경 warning tint 클래스(state-warning-bg)가 포함된다", () => {
    const html = renderTabItem();
    expect(html).toContain("state-warning-bg");
  });
});

// ---------------------------------------------------------------------------
// error — TriangleAlert + state.error.fg (attention bar 제거됨)
// ---------------------------------------------------------------------------

describe("TabItem — error 상태", () => {
  beforeEach(() => {
    currentClaudeStatus = "error";
  });

  test("aria-label='Claude: error'가 렌더된다", () => {
    const html = renderTabItem();
    expect(html).toContain("Claude: error");
  });

  test("state-error-fg 토큰 클래스가 적용된다", () => {
    const html = renderTabItem();
    expect(html).toContain("state-error-fg");
  });

  test("좌측 attention bar(rounded-none)가 없다 — bar 제거됨", () => {
    const html = renderTabItem();
    expect(html).not.toContain("rounded-none");
  });
});

// ---------------------------------------------------------------------------
// store 미설정 — Claude 상태 없음
// ---------------------------------------------------------------------------

describe("TabItem — Claude 상태 없음(store 비어있음)", () => {
  beforeEach(() => {
    currentClaudeStatus = undefined;
  });

  test("Claude aria-label이 전혀 렌더되지 않는다", () => {
    const html = renderTabItem();
    expect(html).not.toContain("Claude:");
  });

  test("attention bar가 없다", () => {
    const html = renderTabItem();
    expect(html).not.toContain("rounded-none");
  });
});
