import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import { CenterWorkbenchView } from "../../src/renderer/components/CenterWorkbench";
import { EditorPaneView } from "../../src/renderer/components/EditorPane";
import { FileTreePanel } from "../../src/renderer/components/FileTreePanel";
import {
  WorkspaceStripView,
  workspaceTabId,
} from "../../src/renderer/components/WorkspaceStrip";
import { DEFAULT_EDITOR_PANE_ID, tabIdFor } from "../../src/renderer/services/editor-types";
import { shouldIgnoreKeyboardShortcut } from "../../src/renderer/stores/keyboard-registry";

import {
  createTab,
  findElementByPredicate,
  findElementsByPredicate,
  findText,
  hasTextChild,
  shortcutCases,
} from "./_fixtures/renderer-stability-fixtures";

describe("CJK regression coverage for new integration surfaces", () => {
  test("workspace strip, filetree, editor content, maximize rendering, and IME guards keep Korean text stable", () => {
    const maximizedWorkbench = CenterWorkbenchView({
      editorArea: <div data-korean-editor="true">편집기 출력</div>,
      bottomPanel: <div data-korean-bottom-panel="true">하단 패널 출력 보존</div>,
      bottomPanelPosition: "bottom",
      bottomPanelExpanded: true,
      bottomPanelSize: 320,
      editorMaximized: true,
    });
    expect(findElementByPredicate(maximizedWorkbench, (element) => element.props?.["data-korean-editor"] === "true")).toBeDefined();
    expect(findElementByPredicate(maximizedWorkbench, (element) => element.props?.["data-korean-bottom-panel"] === "true")).toBeDefined();

    const workspaceStrip = WorkspaceStripView({
      sidebarState: {
        openWorkspaces: [
          { id: "ws_alpha" as WorkspaceId, absolutePath: "/tmp/한글 프로젝트", displayName: "한글프로젝트" },
          { id: "ws_beta" as WorkspaceId, absolutePath: "/tmp/beta", displayName: "Beta" },
          { id: "ws_gamma" as WorkspaceId, absolutePath: "/tmp/gamma", displayName: "Gamma" },
        ],
        activeWorkspaceId: "ws_alpha" as WorkspaceId,
      },
      badgeByWorkspaceId: {
        ws_alpha: {
          workspaceId: "ws_alpha" as WorkspaceId,
          adapterName: "claude-code",
          sessionId: "sess-alpha",
          state: "running",
          timestamp: "2026-04-28T00:00:00.000Z",
        },
      },
      onActivateWorkspace() {},
      onCloseWorkspace() {},
      onOpenFolder() {},
    });
    const tablist = findElementByPredicate(workspaceStrip, (element) => element.props?.role === "tablist");
    const koreanWorkspaceText = findElementByPredicate(workspaceStrip, (element) => hasTextChild(element, "한글프로젝트"));
    expect(tablist?.props["aria-orientation"]).toBe("vertical");
    expect(String(koreanWorkspaceText?.props.className)).toContain("truncate");
    expect(findElementByPredicate(workspaceStrip, (element) => element.props?.["data-harness-badge-state"] === "running")).toBeDefined();

    const fileTree = FileTreePanel({
      activeWorkspace: { id: "ws_alpha" as WorkspaceId, absolutePath: "/tmp/한글 프로젝트", displayName: "한글프로젝트" },
      workspaceTabId: workspaceTabId("ws_alpha" as WorkspaceId),
      fileTree: { workspaceId: "ws_alpha" as WorkspaceId, rootPath: "/tmp/한글 프로젝트", nodes: [], loading: false, errorMessage: null, readAt: null },
      expandedPaths: {},
      gitBadgeByPath: {},
      onRefresh() {},
      onToggleDirectory() {},
      onOpenFile() {},
      onCreateNode() {},
      onDeleteNode() {},
      onRenameNode() {},
    });
    expect(findElementByPredicate(fileTree, (element) => element.props?.role === "tabpanel")?.props["aria-labelledby"]).toBe(workspaceTabId("ws_alpha" as WorkspaceId));
    expect(findText(fileTree, "한글프로젝트")).toBe(true);

    const koreanEditorTab = createTab("왼쪽.ts");
    const editorContentTree = EditorPaneView({
      activeWorkspaceName: "한글프로젝트",
      paneId: DEFAULT_EDITOR_PANE_ID,
      tabs: [koreanEditorTab],
      activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "왼쪽.ts"),
      onActivatePane() {},
      onChangeContent() {},
    });
    const monacoHost = findElementByPredicate(
      editorContentTree,
      (element) => typeof element.type === "function" && element.type.name === "MonacoEditorHost",
    );
    expect(monacoHost?.props.path).toBe("왼쪽.ts");
    expect(findElementsByPredicate(editorContentTree, (element) => element.props?.["data-editor-tab-title-active"] !== undefined)).toHaveLength(0);

    for (const shortcut of shortcutCases) {
      expect(shouldIgnoreKeyboardShortcut({ isComposing: true, ...shortcut })).toBe(true);
    }
    expect(shouldIgnoreKeyboardShortcut({ isComposing: false, key: "Process", keyCode: 229 })).toBe(true);
    console.info(
      `cjk-regression-new-surfaces-metrics ${JSON.stringify({
        imeGuardCases: shortcutCases.length + 1,
        cjkSurfaces: 4,
      })}`,
    );
  });
});
