import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ReactElement, ReactNode } from "react";

import type {
  EditorBridgeRequest,
  EditorBridgeResultFor,
  LspLanguage,
} from "../../../shared/src/contracts/editor/editor-bridge";
import type {
  LspClientPayloadMessage,
  LspServerPayloadMessage,
  LspServerStartedReply,
  LspServerStartFailedReply,
  LspServerStoppedEvent,
  LspStartServerCommand,
  LspStopAllServersCommand,
  LspStopAllServersReply,
  LspStopServerCommand,
} from "../../../shared/src/contracts/lsp/lsp-sidecar";
import type { WorkspaceId, WorkspaceRegistry } from "../../../shared/src/contracts/workspace/workspace";
import type { WorkspaceSidebarState } from "../../../shared/src/contracts/workspace/workspace-shell";
import { registerAppCommands, closeActiveEditorTabOrWorkspace } from "../../src/renderer/App";
import {
  CENTER_TERMINAL_MIN_HEIGHT,
  CenterWorkbenchView,
  clampCenterSplitRatio,
} from "../../src/renderer/components/CenterWorkbench";
import { FileTreePanel } from "../../src/renderer/components/FileTreePanel";
import { PanelResizeHandle } from "../../src/renderer/components/PanelResizeHandle";
import { SplitEditorPane } from "../../src/renderer/components/SplitEditorPane";
import {
  scrollWorkspaceTabIntoView,
  WorkspaceStripView,
  workspaceTabId,
} from "../../src/renderer/components/WorkspaceStrip";
import {
  DEFAULT_EDITOR_PANE_ID,
  SECONDARY_EDITOR_PANE_ID,
  createEditorStore,
  getActiveEditorTabId,
  migrateCenterWorkbenchMode,
  migrateEditorPanesState,
  tabIdFor,
  type EditorBridge,
  type EditorPaneState,
  type EditorStore,
  type EditorTab,
} from "../../src/renderer/stores/editor-store";
import { keyboardRegistryStore, normalizeKeychord, shouldIgnoreKeyboardShortcut } from "../../src/renderer/stores/keyboard-registry";
import { createWorkspaceStore, type WorkspaceStore } from "../../src/renderer/stores/workspace-store";
import { LspService, type LspSidecarClient } from "../../src/main/lsp/lsp-service";

const tempDirs: string[] = [];
const stableNow = () => new Date("2026-04-28T00:00:00.000Z");

const languageScenarios: Array<{
  workspaceId: WorkspaceId;
  language: LspLanguage;
  harness: "claude-code" | "codex" | "opencode";
  relativePath: string;
  content: string;
}> = [
  {
    workspaceId: "ws_m6_ts" as WorkspaceId,
    language: "typescript",
    harness: "claude-code",
    relativePath: "src/index.ts",
    content: "export function greet(name: string) { return name; }\n",
  },
  {
    workspaceId: "ws_m6_py" as WorkspaceId,
    language: "python",
    harness: "codex",
    relativePath: "src/main.py",
    content: "def greet(name: str) -> str:\n    return name\n",
  },
  {
    workspaceId: "ws_m6_go" as WorkspaceId,
    language: "go",
    harness: "opencode",
    relativePath: "src/main.go",
    content: "package main\nfunc greet(name string) string { return name }\n",
  },
];

const shortcutCases = [
  { key: "W", keyCode: 87 },
  { key: "B", keyCode: 66 },
  { key: "1", keyCode: 49 },
  { key: "2", keyCode: 50 },
  { key: "3", keyCode: 51 },
  { key: "M", keyCode: 77 },
  { key: "\\", keyCode: 220 },
  { key: "ArrowLeft", keyCode: 37 },
  { key: "ArrowRight", keyCode: 39 },
];

afterEach(async () => {
  keyboardRegistryStore.setState({ bindings: {}, commands: {} });
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("M6 integrated stability smoke (shortened/fake-sidecar)", () => {
  test("A: exercises 3 workspaces × 3 harness labels × 3 languages × 9 LSP capabilities with restart/relay/zombie checks", async () => {
    const registry = await createWorkspaceRegistry();
    const sidecarClient = new StabilityLspSidecarClient();
    const service = new LspService({
      workspacePersistenceStore: { getWorkspaceRegistry: async () => registry },
      sidecarClient,
      now: stableNow,
      initializeTimeoutMs: 100,
      shutdownTimeoutMs: 100,
    });

    const matrixResults: string[] = [];
    const recoveryDurationsMs: number[] = [];

    expect(new Set(languageScenarios.map((scenario) => scenario.workspaceId)).size).toBe(3);
    expect(new Set(languageScenarios.map((scenario) => scenario.harness)).size).toBe(3);
    expect(new Set(languageScenarios.map((scenario) => scenario.language)).size).toBe(3);

    for (const scenario of languageScenarios) {
      await service.openDocument({
        type: "lsp-document/open",
        workspaceId: scenario.workspaceId,
        path: scenario.relativePath,
        language: scenario.language,
        content: scenario.content,
        version: 1,
      });

      await expect(
        service.complete({
          type: "lsp-completion/complete",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
          triggerKind: "invoked",
          triggerCharacter: null,
        }),
      ).resolves.toMatchObject({ items: [{ label: `${scenario.language}-completion` }] });
      matrixResults.push(`${scenario.language}:completion`);

      await expect(
        service.hover({
          type: "lsp-hover/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({ contents: [{ value: `${scenario.language} hover 한글` }] });
      matrixResults.push(`${scenario.language}:hover`);

      await expect(
        service.definition({
          type: "lsp-definition/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({ targets: [{ type: "location-link", targetPath: scenario.relativePath }] });
      matrixResults.push(`${scenario.language}:definition`);

      await expect(
        service.references({
          type: "lsp-references/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
          includeDeclaration: true,
        }),
      ).resolves.toMatchObject({ locations: [{ path: scenario.relativePath }] });
      matrixResults.push(`${scenario.language}:references`);

      await expect(
        service.prepareRename({
          type: "lsp-rename/prepare",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({ canRename: true, placeholder: "value" });
      await expect(
        service.renameSymbol({
          type: "lsp-rename/rename",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
          newName: `${scenario.language}_renamed`,
        }),
      ).resolves.toMatchObject({ workspaceEdit: { changes: [{ path: scenario.relativePath }] } });
      matrixResults.push(`${scenario.language}:rename`);

      await expect(
        service.formatDocument({
          type: "lsp-formatting/document",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          options: { tabSize: 2, insertSpaces: true },
        }),
      ).resolves.toMatchObject({ edits: [{ newText: `${scenario.language}-formatted` }] });
      await expect(
        service.formatRange({
          type: "lsp-formatting/range",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          range: protocolRange(0, 0, 0, 5),
          options: { tabSize: 2, insertSpaces: true },
        }),
      ).resolves.toMatchObject({ edits: [{ newText: `${scenario.language}-range-formatted` }] });
      matrixResults.push(`${scenario.language}:formatting`);

      await expect(
        service.getSignatureHelp({
          type: "lsp-signature-help/get",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 8 },
          triggerKind: "trigger-character",
          triggerCharacter: "(",
        }),
      ).resolves.toMatchObject({ signatureHelp: { signatures: [{ label: `${scenario.language}Fn(value)` }] } });
      matrixResults.push(`${scenario.language}:signature-help`);

      await expect(
        service.codeActions({
          type: "lsp-code-action/list",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          range: protocolRange(0, 0, 0, 5),
          diagnostics: [],
          only: "quickfix",
        }),
      ).resolves.toMatchObject({ actions: [{ title: `${scenario.language} quick fix`, kind: "quickfix" }] });
      matrixResults.push(`${scenario.language}:code-action`);

      await expect(
        service.documentSymbols({
          type: "lsp-document-symbols/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
        }),
      ).resolves.toMatchObject({ symbols: [{ name: `${scenario.language}Symbol`, kind: "function" }] });
      matrixResults.push(`${scenario.language}:document-symbols`);

      const initializeMessages = sidecarClient.startedServers
        .filter((server) => server.command.workspaceId === scenario.workspaceId)
        .flatMap((server) => server.receivedMessages.filter((message) => message.method === "initialize"));
      expect(initializeMessages.length).toBeGreaterThan(0);
      expect(JSON.stringify(initializeMessages[0]?.params ?? {})).not.toContain("inlayHint");

      for (let crashIndex = 0; crashIndex < 3; crashIndex += 1) {
        const startsBeforeCrash = sidecarClient.startCommandsFor(scenario.workspaceId, scenario.language).length;
        const startedAt = Date.now();
        sidecarClient.crashServer(scenario.workspaceId, scenario.language);
        await waitFor(async () => {
          expect(sidecarClient.startCommandsFor(scenario.workspaceId, scenario.language)).toHaveLength(startsBeforeCrash + 1);
          const status = await service.readStatus({
            type: "lsp-status/read",
            workspaceId: scenario.workspaceId,
            languages: [scenario.language],
          });
          expect(status.statuses[0]?.state).toBe("ready");
        }, 5_000);
        recoveryDurationsMs.push(Date.now() - startedAt);
      }

      await expect(
        service.hover({
          type: "lsp-hover/read",
          workspaceId: scenario.workspaceId,
          path: scenario.relativePath,
          language: scenario.language,
          position: { line: 0, character: 3 },
        }),
      ).resolves.toMatchObject({ contents: [{ value: `${scenario.language} hover 한글` }] });
    }

    const maxRecoveryMs = Math.max(...recoveryDurationsMs);
    expect(matrixResults).toHaveLength(27);
    expect(maxRecoveryMs).toBeLessThan(5_000);
    expect(recoveryDurationsMs).toHaveLength(9);
    expect(sidecarClient.droppedClientPayloads).toBe(0);
    expect(sidecarClient.malformedPayloads).toBe(0);
    expect(sidecarClient.relayServerSeqs).toEqual(sequenceFromOne(sidecarClient.relayServerSeqs.length));
    expect(sidecarClient.stopCommands.filter((command) => command.reason === "restart")).toHaveLength(0);
    console.info(
      `m6-lsp-metrics ${JSON.stringify({
        matrixResults: matrixResults.length,
        restartCycles: recoveryDurationsMs.length,
        maxRecoveryMs,
        relayDrops: sidecarClient.droppedClientPayloads,
        malformedPayloads: sidecarClient.malformedPayloads,
        relayServerFrames: sidecarClient.relayServerSeqs.length,
      })}`,
    );

    await service.dispose();
    expect(sidecarClient.activeServerCount()).toBe(0);
    expect(sidecarClient.stopAllCommands.at(-1)?.reason).toBe("app-shutdown");
  });

  test("B/C: layout, migration, ARIA, CJK rendering, and IME-protected split surface stay stable over 50+ cycles", async () => {
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const modes = ["split", "editor-max", "terminal-max"] as const;
      for (let index = 0; index < 54; index += 1) {
        const tree = CenterWorkbenchView({
          mode: modes[index % modes.length],
          activePane: index % 2 === 0 ? "editor" : "terminal",
          onActivePaneChange() {},
          onModeChange() {},
          editorPane: <div data-korean-editor="true">편집기 출력 {index}</div>,
          terminalPane: <div data-korean-terminal="true">터미널 출력 보존</div>,
        });
        expect(findElementByPredicate(tree, (element) => element.props?.["data-korean-editor"] === "true")).toBeDefined();
        expect(findElementByPredicate(tree, (element) => element.props?.["data-korean-terminal"] === "true")).toBeDefined();
        const hiddenPane = modes[index % modes.length] === "editor-max"
          ? findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "terminal")
          : modes[index % modes.length] === "terminal-max"
            ? findElementByPredicate(tree, (element) => element.props?.["data-center-pane"] === "editor")
            : undefined;
        if (hiddenPane) {
          expect(hiddenPane.props.style.visibility).toBe("hidden");
          expect(hiddenPane.props.style.height).toBe(0);
          expect(hiddenPane.props.style.display).not.toBe("none");
        }
      }
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual([]);
    expect(clampCenterSplitRatio(0.99, 300)).toBe((300 - CENTER_TERMINAL_MIN_HEIGHT) / 300);
    expect(migrateCenterWorkbenchMode("editor")).toBe("editor-max");
    expect(migrateCenterWorkbenchMode("terminal")).toBe("terminal-max");
    expect(migrateEditorPanesState({ tabs: [createTab("README.md")], activeTabId: "missing" })).toMatchObject({
      panes: [{ id: DEFAULT_EDITOR_PANE_ID, activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "README.md") }],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    const editorStore = createEditorStore(createFakeEditorBridge());
    editorStore.setState({
      activeWorkspaceId: "ws_alpha" as WorkspaceId,
      panes: [{ id: DEFAULT_EDITOR_PANE_ID, tabs: [createTab("한글.ts"), createTab("보조.ts")], activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "한글.ts") }],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    for (let index = 0; index < 51; index += 1) {
      editorStore.getState().splitActivePaneRight();
      expect(editorStore.getState().panes).toHaveLength(2);
      expect(editorStore.getState().panes.length).toBeLessThanOrEqual(2);
      editorStore.getState().activatePane(DEFAULT_EDITOR_PANE_ID);
      editorStore.getState().moveActiveTabToPane("right");
      expect(editorStore.getState().activePaneId).toBe(SECONDARY_EDITOR_PANE_ID);
      expect(editorStore.getState().panes.find((pane) => pane.id === SECONDARY_EDITOR_PANE_ID)?.tabs).toHaveLength(1);
      editorStore.getState().moveActiveTabToPane("left");
      expect(editorStore.getState().activePaneId).toBe(DEFAULT_EDITOR_PANE_ID);
      editorStore.getState().activatePane(SECONDARY_EDITOR_PANE_ID);
      editorStore.getState().splitActivePaneRight();
      expect(editorStore.getState().panes).toHaveLength(1);
    }

    editorStore.setState({
      panes: [
        { id: DEFAULT_EDITOR_PANE_ID, tabs: [createTab("한글.ts"), createTab("보조.ts")], activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "한글.ts") },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });
    editorStore.getState().splitActivePaneRight();
    editorStore.getState().activatePane(DEFAULT_EDITOR_PANE_ID);
    editorStore.getState().moveActiveTabToPane("right");
    await editorStore.getState().closeTab(SECONDARY_EDITOR_PANE_ID, tabIdFor("ws_alpha" as WorkspaceId, "한글.ts"));
    expect(editorStore.getState().panes).toHaveLength(1);
    expect(editorStore.getState().panes[0]?.tabs.map((tab) => tab.title)).toEqual(["보조.ts"]);

    const sharedKoreanTab = createTab("공유.ts");
    editorStore.setState({
      panes: [
        { id: DEFAULT_EDITOR_PANE_ID, tabs: [sharedKoreanTab], activeTabId: sharedKoreanTab.id },
        { id: SECONDARY_EDITOR_PANE_ID, tabs: [sharedKoreanTab], activeTabId: sharedKoreanTab.id },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });
    await editorStore.getState().updateTabContent(sharedKoreanTab.id, "const 한글 = 2;\n");
    expect(editorStore.getState().panes.flatMap((pane) => pane.tabs).map((tab) => tab.dirty)).toEqual([true, true]);

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

    const splitTree = SplitEditorPane({
      activeWorkspaceId: "ws_alpha" as WorkspaceId,
      activeWorkspaceName: "한글프로젝트",
      panes: [
        { id: DEFAULT_EDITOR_PANE_ID, tabs: [createTab("왼쪽.ts")], activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "왼쪽.ts") },
        { id: SECONDARY_EDITOR_PANE_ID, tabs: [createTab("오른쪽.ts")], activeTabId: tabIdFor("ws_alpha" as WorkspaceId, "오른쪽.ts") },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
      onActivatePane() {},
      onSplitRight() {},
      onActivateTab() {},
      onCloseTab() {},
      onSaveTab() {},
      onChangeContent() {},
    });
    const tabTitles = findElementsByPredicate(splitTree, (element) => element.props?.["data-editor-tab-title-active"] !== undefined);
    expect(tabTitles.map((element) => textContent(element))).toEqual(["왼쪽.ts", "오른쪽.ts"]);
    expect(String(tabTitles[0]?.props.className)).toContain("font-semibold");
    expect(String(tabTitles[1]?.props.className)).toContain("font-semibold");

    let resizeKeydowns = 0;
    const handles = ["Workspace/Filetree", "Filetree/Center", "Center/Shared"].map((label) =>
      PanelResizeHandle({
        orientation: "vertical",
        dragging: false,
        "aria-valuemin": 120,
        "aria-valuemax": 512,
        "aria-valuenow": 240,
        "aria-label": label,
        onPointerDown() {},
        onKeyDown(event) {
          resizeKeydowns += 1;
          event.preventDefault();
        },
      }),
    );
    for (const handle of handles) {
      handle.props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
    }
    expect(resizeKeydowns).toBe(3);

    for (const shortcut of shortcutCases) {
      expect(shouldIgnoreKeyboardShortcut({ isComposing: true, ...shortcut })).toBe(true);
    }
    expect(shouldIgnoreKeyboardShortcut({ isComposing: false, key: "Process", keyCode: 229 })).toBe(true);
    console.info(
      `m6-layout-cjk-metrics ${JSON.stringify({
        centerCycles: 54,
        editorSplitCycles: 51,
        resizeKeydowns,
        imeGuardCases: shortcutCases.length + 1,
        cjkSurfaces: 4,
      })}`,
    );
  });

  test("D: keybinding registry resolves VSCode-like shortcuts, Cmd+W fallback, workspace switching, and IME guard", async () => {
    const editorStore = createEditorStore(createFakeEditorBridge());
    const workspaceStore = createFakeWorkspaceStore({
      openWorkspaces: [
        { id: "ws_alpha" as WorkspaceId, absolutePath: "/tmp/alpha", displayName: "Alpha" },
        { id: "ws_beta" as WorkspaceId, absolutePath: "/tmp/beta", displayName: "Beta" },
        { id: "ws_gamma" as WorkspaceId, absolutePath: "/tmp/gamma", displayName: "Gamma" },
      ],
      activeWorkspaceId: "ws_alpha" as WorkspaceId,
    });
    let closeWorkspaceCount = 0;
    let toggleSidebarCount = 0;
    let toggleMaximizeCount = 0;
    let splitRightCount = 0;
    const movedDirections: string[] = [];

    registerAppCommands({
      closeWorkspace: async () => {
        closeWorkspaceCount += 1;
      },
      editorStore,
      moveActiveEditorTabToPane: (direction) => movedDirections.push(direction),
      openFolder: async () => {},
      splitEditorPaneRight: () => {
        splitRightCount += 1;
      },
      setCommandPaletteOpen() {},
      toggleActiveCenterPaneMaximize: () => {
        toggleMaximizeCount += 1;
      },
      toggleSharedPanel() {},
      toggleWorkspacePanel: () => {
        toggleSidebarCount += 1;
      },
      workspaceStore,
    });

    expect(keyboardRegistryStore.getState().bindings).toMatchObject({
      "Cmd+W": "editor.closeActiveTab",
      "Cmd+Shift+W": "workspace.close",
      "Cmd+B": "view.toggleSidebar",
      "Cmd+1": "workspace.switch.1",
      "Cmd+2": "workspace.switch.2",
      "Cmd+3": "workspace.switch.3",
      "Cmd+Shift+M": "view.toggleCenterPaneMaximize",
      "Cmd+\\": "editor.splitRight",
      "Cmd+Alt+ArrowLeft": "editor.moveActiveTabLeft",
      "Cmd+Alt+ArrowRight": "editor.moveActiveTabRight",
    });
    expect(normalizeKeychord("cmd+alt+←")).toBe("Cmd+Alt+ArrowLeft");
    expect(normalizeKeychord("cmd+alt+→")).toBe("Cmd+Alt+ArrowRight");

    const tab = createTab("단축키.ts", { language: null, monacoLanguage: "typescript" });
    editorStore.setState({
      activeWorkspaceId: "ws_alpha" as WorkspaceId,
      panes: [{ id: DEFAULT_EDITOR_PANE_ID, tabs: [tab], activeTabId: tab.id }],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    });

    await keyboardRegistryStore.getState().executeCommand("editor.closeActiveTab");
    expect(getActiveEditorTabId(editorStore.getState())).toBeNull();
    expect(editorStore.getState().panes[0]?.tabs).toEqual([]);
    expect(closeWorkspaceCount).toBe(0);

    await closeActiveEditorTabOrWorkspace({
      closeWorkspace: async () => {
        closeWorkspaceCount += 1;
      },
      editorStore,
      workspaceStore,
    });
    expect(closeWorkspaceCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("workspace.close");
    expect(closeWorkspaceCount).toBe(2);

    await keyboardRegistryStore.getState().executeCommand("view.toggleSidebar");
    expect(toggleSidebarCount).toBe(1);

    await keyboardRegistryStore.getState().executeCommand("workspace.switch.2");
    expect(workspaceStore.getState().sidebarState.activeWorkspaceId).toBe("ws_beta");
    await keyboardRegistryStore.getState().executeCommand("workspace.switch.3");
    expect(workspaceStore.getState().sidebarState.activeWorkspaceId).toBe("ws_gamma");

    let observedScrollOptions: boolean | ScrollIntoViewOptions | undefined;
    scrollWorkspaceTabIntoView({
      scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
        observedScrollOptions = options;
      },
    });
    expect(observedScrollOptions).toEqual({ block: "nearest" });

    await keyboardRegistryStore.getState().executeCommand("view.toggleCenterPaneMaximize");
    await keyboardRegistryStore.getState().executeCommand("editor.splitRight");
    await keyboardRegistryStore.getState().executeCommand("editor.moveActiveTabLeft");
    await keyboardRegistryStore.getState().executeCommand("editor.moveActiveTabRight");
    expect(toggleMaximizeCount).toBe(1);
    expect(splitRightCount).toBe(1);
    expect(movedDirections).toEqual(["left", "right"]);

    for (const shortcut of shortcutCases) {
      expect(shouldIgnoreKeyboardShortcut({ isComposing: true, ...shortcut })).toBe(true);
    }
    console.info(
      `m6-keybinding-metrics ${JSON.stringify({
        registeredBindingsChecked: 10,
        closeWorkspaceCount,
        toggleSidebarCount,
        workspaceSwitchesChecked: 2,
        imeGuardCases: shortcutCases.length,
        splitShortcutCount: splitRightCount,
        moveShortcutCount: movedDirections.length,
      })}`,
    );
  });
});

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

class StabilityLspSidecarClient implements LspSidecarClient {
  public readonly startCommands: LspStartServerCommand[] = [];
  public readonly stopCommands: LspStopServerCommand[] = [];
  public readonly stopAllCommands: LspStopAllServersCommand[] = [];
  public readonly startedServers: StabilityLanguageServerSession[] = [];
  public readonly relayServerSeqs: number[] = [];
  public droppedClientPayloads = 0;
  public malformedPayloads = 0;
  private readonly servers = new Map<string, StabilityLanguageServerSession>();
  private readonly payloadListeners = new Set<(message: LspServerPayloadMessage) => void>();
  private readonly stoppedListeners = new Set<(event: LspServerStoppedEvent) => void>();
  private serverPayloadSeq = 1;

  public async startServer(command: LspStartServerCommand): Promise<LspServerStartedReply | LspServerStartFailedReply> {
    this.startCommands.push(command);
    const session = new StabilityLanguageServerSession(this, command);
    this.servers.set(command.serverId, session);
    this.startedServers.push(session);
    return {
      type: "lsp/lifecycle",
      action: "server_started",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      language: command.language,
      serverName: command.serverName,
      pid: 7000 + this.startedServers.length,
    };
  }

  public async stopServer(command: LspStopServerCommand): Promise<LspServerStoppedEvent> {
    this.stopCommands.push(command);
    this.servers.delete(command.serverId);
    const event: LspServerStoppedEvent = {
      type: "lsp/lifecycle",
      action: "server_stopped",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      language: command.language,
      serverName: command.serverName,
      reason: command.reason,
      exitCode: 0,
      signal: null,
      stoppedAt: stableNow().toISOString(),
    };
    this.emitStopped(event);
    return event;
  }

  public async stopAllServers(command: LspStopAllServersCommand): Promise<LspStopAllServersReply> {
    this.stopAllCommands.push(command);
    const stoppedServerIds = Array.from(this.servers.values())
      .filter((server) => !command.workspaceId || server.command.workspaceId === command.workspaceId)
      .map((server) => server.command.serverId);
    for (const serverId of stoppedServerIds) {
      this.servers.delete(serverId);
    }
    return {
      type: "lsp/lifecycle",
      action: "stop_all_stopped",
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      stoppedServerIds,
    };
  }

  public async stopAllLspServers(reason = "app-shutdown" as const): Promise<void> {
    await this.stopAllServers({
      type: "lsp/lifecycle",
      action: "stop_all",
      requestId: `m6-stop-all-${this.stopAllCommands.length + 1}`,
      workspaceId: null,
      reason,
    });
  }

  public sendClientPayload(message: LspClientPayloadMessage): void {
    const server = this.servers.get(message.serverId);
    if (!server) {
      this.droppedClientPayloads += 1;
      return;
    }
    server.receive(message.payload);
  }

  public onServerPayload(listener: (message: LspServerPayloadMessage) => void) {
    this.payloadListeners.add(listener);
    return { dispose: () => this.payloadListeners.delete(listener) };
  }

  public onServerStopped(listener: (event: LspServerStoppedEvent) => void) {
    this.stoppedListeners.add(listener);
    return { dispose: () => this.stoppedListeners.delete(listener) };
  }

  public emitServerPayload(command: LspStartServerCommand, payload: string): void {
    const seq = this.serverPayloadSeq++;
    this.relayServerSeqs.push(seq);
    const message: LspServerPayloadMessage = {
      type: "lsp/relay",
      direction: "server_to_client",
      workspaceId: command.workspaceId,
      serverId: command.serverId,
      seq,
      payload,
    };
    for (const listener of [...this.payloadListeners]) {
      listener(message);
    }
  }

  public crashServer(workspaceId: WorkspaceId, language: LspLanguage): void {
    const serverId = `${workspaceId}:${language}`;
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`No active fake server for ${serverId}`);
    }
    this.servers.delete(serverId);
    this.emitStopped({
      type: "lsp/lifecycle",
      action: "server_stopped",
      workspaceId,
      serverId,
      language,
      serverName: server.command.serverName,
      reason: "restart",
      exitCode: null,
      signal: "SIGKILL",
      stoppedAt: stableNow().toISOString(),
    });
  }

  public startCommandsFor(workspaceId: WorkspaceId, language: LspLanguage): LspStartServerCommand[] {
    return this.startCommands.filter((command) => command.workspaceId === workspaceId && command.language === language);
  }

  public activeServerCount(): number {
    return this.servers.size;
  }

  private emitStopped(event: LspServerStoppedEvent): void {
    for (const listener of [...this.stoppedListeners]) {
      listener(event);
    }
  }
}

class StabilityLanguageServerSession {
  public readonly receivedMessages: JsonRpcMessage[] = [];
  private readonly parser = new TestJsonRpcParser(
    (message) => {
      this.receivedMessages.push(message);
      this.handleClientMessage(message);
    },
    () => {
      this.client.malformedPayloads += 1;
    },
  );

  public constructor(
    private readonly client: StabilityLspSidecarClient,
    public readonly command: LspStartServerCommand,
  ) {}

  public receive(payload: string): void {
    this.parser.push(Buffer.from(payload, "utf8"));
  }

  private handleClientMessage(message: JsonRpcMessage): void {
    if (message.method === "initialize" && message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            completionProvider: { triggerCharacters: ["."] },
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: { prepareProvider: true },
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
            signatureHelpProvider: { triggerCharacters: ["(", ","] },
            codeActionProvider: { codeActionKinds: ["quickfix", "source.organizeImports"] },
            documentSymbolProvider: true,
          },
        },
      });
      return;
    }

    if (message.method === "textDocument/completion" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { isIncomplete: false, items: [{ label: `${this.command.language}-completion`, kind: 3, insertText: `${this.command.language}($0)`, insertTextFormat: 2 }] } });
      return;
    }
    if (message.method === "textDocument/hover" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: `${this.command.language} hover 한글` }, range: protocolRange(0, 0, 0, 5) } });
      return;
    }
    if (message.method === "textDocument/definition" && message.id !== undefined) {
      const uri = textDocumentUri(message);
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ targetUri: uri, targetRange: protocolRange(0, 0, 0, 5), targetSelectionRange: protocolRange(0, 0, 0, 5) }] });
      return;
    }
    if (message.method === "textDocument/references" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ uri: textDocumentUri(message), range: protocolRange(0, 0, 0, 5) }] });
      return;
    }
    if (message.method === "textDocument/prepareRename" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { range: protocolRange(0, 0, 0, 5), placeholder: "value" } });
      return;
    }
    if (message.method === "textDocument/rename" && message.id !== undefined) {
      const newName = typeof message.params?.newName === "string" ? message.params.newName : `${this.command.language}_renamed`;
      this.send({ jsonrpc: "2.0", id: message.id, result: { changes: { [textDocumentUri(message)]: [{ range: protocolRange(0, 0, 0, 5), newText: newName }] } } });
      return;
    }
    if (message.method === "textDocument/formatting" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ range: protocolRange(0, 0, 0, 5), newText: `${this.command.language}-formatted` }] });
      return;
    }
    if (message.method === "textDocument/rangeFormatting" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ range: protocolRange(0, 0, 0, 5), newText: `${this.command.language}-range-formatted` }] });
      return;
    }
    if (message.method === "textDocument/signatureHelp" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: { signatures: [{ label: `${this.command.language}Fn(value)`, parameters: [{ label: "value" }] }], activeSignature: 0, activeParameter: 0 } });
      return;
    }
    if (message.method === "textDocument/codeAction" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ title: `${this.command.language} quick fix`, kind: "quickfix", isPreferred: true, edit: { changes: { [textDocumentUri(message)]: [{ range: protocolRange(0, 0, 0, 0), newText: "// fixed\n" }] } } }] });
      return;
    }
    if (message.method === "textDocument/documentSymbol" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: [{ name: `${this.command.language}Symbol`, detail: "", kind: 12, range: protocolRange(0, 0, 0, 5), selectionRange: protocolRange(0, 0, 0, 5), children: [] }] });
      return;
    }
    if (message.method === "shutdown" && message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }

  private send(message: JsonRpcMessage): void {
    this.client.emitServerPayload(this.command, frameJsonRpcMessage(message));
  }
}

class TestJsonRpcParser {
  private buffer = Buffer.alloc(0);

  public constructor(
    private readonly onMessage: (message: JsonRpcMessage) => void,
    private readonly onMalformed: () => void,
  ) {}

  public push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const contentLengthMatch = /^Content-Length:\s*(\d+)/im.exec(header);
        if (!contentLengthMatch) {
          this.onMalformed();
          this.buffer = Buffer.alloc(0);
          return;
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(contentLengthMatch[1]);
        if (this.buffer.length < bodyEnd) {
          return;
        }

        const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
        this.buffer = this.buffer.subarray(bodyEnd);
        this.onMessage(JSON.parse(body) as JsonRpcMessage);
      }
    } catch {
      this.onMalformed();
    }
  }
}

async function createWorkspaceRegistry(): Promise<WorkspaceRegistry> {
  const workspaces = [];
  for (const scenario of languageScenarios) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `nexus-m6-${scenario.language}-`));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    workspaces.push({
      id: scenario.workspaceId,
      absolutePath: tempDir,
      displayName: `M6 ${scenario.language}`,
      createdAt: stableNow().toISOString(),
      lastOpenedAt: stableNow().toISOString(),
    });
  }
  return { version: 1, workspaces };
}

function frameJsonRpcMessage(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function protocolRange(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function textDocumentUri(message: JsonRpcMessage): string {
  const textDocument = message.params?.textDocument;
  if (typeof textDocument === "object" && textDocument !== null && "uri" in textDocument && typeof textDocument.uri === "string") {
    return textDocument.uri;
  }
  return pathToFileURL("/tmp/fallback.ts").href;
}

function sequenceFromOne(length: number): number[] {
  return Array.from({ length }, (_, index) => index + 1);
}

function createTab(pathName: string, overrides: Partial<EditorTab> = {}): EditorTab {
  const workspaceId = "ws_alpha" as WorkspaceId;
  return {
    id: tabIdFor(workspaceId, pathName),
    workspaceId,
    path: pathName,
    title: pathName.split("/").at(-1) ?? pathName,
    content: "const value = 1;\n",
    savedContent: "const value = 1;\n",
    version: "v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language: "typescript",
    monacoLanguage: "typescript",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
    ...overrides,
  };
}

function createFakeEditorBridge(): EditorBridge {
  return {
    async invoke<TRequest extends EditorBridgeRequest>(request: TRequest): Promise<EditorBridgeResultFor<TRequest>> {
      switch (request.type) {
        case "lsp-document/change":
          return {
            type: "lsp-document/change/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            status: {
              language: request.language,
              state: "ready",
              serverName: `${request.language}-server`,
              message: null,
              updatedAt: stableNow().toISOString(),
            },
            changedAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        case "lsp-document/close":
          return {
            type: "lsp-document/close/result",
            workspaceId: request.workspaceId,
            path: request.path,
            language: request.language,
            closedAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        case "workspace-files/file/read":
          return {
            type: "workspace-files/file/read/result",
            workspaceId: request.workspaceId,
            path: request.path,
            content: "const value = 1;\n",
            encoding: "utf8",
            version: "v1",
            readAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        case "workspace-files/file/write":
          return {
            type: "workspace-files/file/write/result",
            workspaceId: request.workspaceId,
            path: request.path,
            version: "v2",
            writtenAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        case "workspace-files/tree/read":
          return {
            type: "workspace-files/tree/read/result",
            workspaceId: request.workspaceId,
            rootPath: "/tmp/ws_alpha",
            nodes: [],
            readAt: stableNow().toISOString(),
          } as EditorBridgeResultFor<TRequest>;
        default:
          throw new Error(`Unhandled fake editor bridge request: ${request.type}`);
      }
    },
  };
}

function createFakeWorkspaceStore(initial: WorkspaceSidebarState): WorkspaceStore {
  let sidebarState = initial;
  const store = createWorkspaceStore({
    async getSidebarState() {
      return sidebarState;
    },
    async openFolder() {
      return sidebarState;
    },
    async activateWorkspace(workspaceId) {
      sidebarState = { ...sidebarState, activeWorkspaceId: workspaceId };
      return sidebarState;
    },
    async closeWorkspace(workspaceId) {
      sidebarState = {
        openWorkspaces: sidebarState.openWorkspaces.filter((workspace) => workspace.id !== workspaceId),
        activeWorkspaceId: sidebarState.openWorkspaces.find((workspace) => workspace.id !== workspaceId)?.id ?? null,
      };
      return sidebarState;
    },
  });
  store.setState({ sidebarState });
  return store;
}

function findElementByPredicate(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement | undefined {
  return findElementsByPredicate(node, predicate)[0];
}

function findElementsByPredicate(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement[] {
  if (isReactElement(node)) {
    const matches = predicate(node) ? [node] : [];
    if (typeof node.type === "function" && node.type.name !== "MonacoEditorHost") {
      return [...matches, ...findElementsByPredicate(node.type(node.props), predicate)];
    }
    return [...matches, ...findElementsByPredicate(node.props.children, predicate)];
  }

  if (Array.isArray(node)) {
    return node.flatMap((child) => findElementsByPredicate(child, predicate));
  }

  return [];
}

function findText(node: ReactNode, text: string): boolean {
  if (typeof node === "string" || typeof node === "number") {
    return String(node) === text;
  }
  if (isReactElement(node)) {
    if (typeof node.type === "function" && node.type.name !== "MonacoEditorHost") {
      return findText(node.type(node.props), text);
    }
    return findText(node.props.children, text);
  }
  if (Array.isArray(node)) {
    return node.some((child) => findText(child, text));
  }
  return false;
}

function hasTextChild(element: ReactElement, text: string): boolean {
  return textContent(element) === text;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (isReactElement(node)) {
    if (typeof node.type === "function" && node.type.name !== "MonacoEditorHost") {
      return textContent(node.type(node.props));
    }
    return textContent(node.props.children);
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join("");
  }
  return "";
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Timed out waiting for assertion.");
}
