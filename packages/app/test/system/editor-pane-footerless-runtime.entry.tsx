import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import type { LspDiagnostic } from "../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import { installMonacoEnvironment } from "../../src/renderer/editor/monaco-environment";
import {
  DEFAULT_EDITOR_GROUP_ID,
  createEditorGroupsService,
  type EditorGroup,
  type EditorGroupTab,
} from "../../src/renderer/services/editor-groups-service";
import type { EditorPaneState, EditorTab, EditorTabId } from "../../src/renderer/services/editor-types";
import {
  createTerminalService,
  type TerminalServiceTerminalLike,
  type TerminalTab,
} from "../../src/renderer/services/terminal-service";
import { EditorGroupsPart } from "../../src/renderer/parts/editor-groups";
import { StatusBarPart, type StatusBarActiveItem } from "../../src/renderer/parts/status-bar";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";

interface EditorPaneFooterlessRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  editorPane: {
    mounted: boolean;
    internalTablistCount: number;
    internalTabCount: number;
    internalTabActionCount: number;
    flexlayoutTabCount: number;
  };
  statusBar: {
    mounted: boolean;
    separateFromEditorPane: boolean;
    separateFromEditorGroupsPart: boolean;
    initialKind: string | null;
    afterTerminalKind: string | null;
    afterFileKind: string | null;
    fileText: string;
    terminalText: string;
  };
  contextMenu: {
    opened: boolean;
    menuItemIds: string[];
    copyRelativePathCalls: string[];
    splitRightCalls: string[];
  };
  middleClick: {
    attempted: boolean;
    tabRemoved: boolean;
    closeCalls: string[];
  };
  reason?: string;
}

declare global {
  interface Window {
    __nexusEditorPaneFooterlessRuntimeSmokeResult?: EditorPaneFooterlessRuntimeSmokeResult;
  }
}

const workspaceId = "ws_editor_pane_footerless_runtime" as WorkspaceId;
const workspaceRoot = "/tmp/nexus-footerless-runtime";
const fileOne = createEditorTab({
  id: "footerless_file_one",
  path: "src/footerless-one.ts",
  title: "footerless-one.ts",
  dirty: false,
  diagnostics: [],
});
const fileTwo = createEditorTab({
  id: "footerless_file_two",
  path: "src/footerless-two.ts",
  title: "footerless-two.ts",
  dirty: true,
  diagnostics: [
    {
      path: "src/footerless-two.ts",
      language: "typescript",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      severity: "warning",
      message: "Fixture warning.",
    },
  ],
});
const terminalTabId = "footerless_terminal_one";
const terminalGroupTab: EditorGroupTab = {
  id: terminalTabId,
  title: "Terminal",
  kind: "terminal",
  workspaceId,
  resourcePath: null,
};
const fileOneGroupTab = editorGroupTabFromEditorTab(fileOne);
const fileTwoGroupTab = editorGroupTabFromEditorTab(fileTwo);
const initialPanes: EditorPaneState[] = [{
  id: DEFAULT_EDITOR_GROUP_ID,
  tabs: [fileOne, fileTwo],
  activeTabId: fileOne.id,
}];
const copyRelativePathCalls: string[] = [];
const splitRightCalls: string[] = [];
const closeCalls: string[] = [];
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;

installMonacoEnvironment();
installConsoleCapture();
void runSmoke();

async function runSmoke(): Promise<void> {
  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);

    const editorGroups = createEditorGroupsService();
    editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, fileOneGroupTab, { activate: true });
    editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, fileTwoGroupTab, { activate: false });
    editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, terminalGroupTab, { activate: false });

    const terminalService = createTerminalService({}, {
      createTerminal: () => new FakeTerminalLike(),
    }, {
      createBridge: () => null,
    });
    terminalService.getState().createTab({
      id: terminalTabId,
      workspaceId,
      shell: "/bin/zsh",
      cwd: workspaceRoot,
      pid: 42_424,
      status: "running",
      createdAt: "2026-04-29T00:00:00.000Z",
      activate: true,
    });

    createRoot(rootElement).render(
      <StrictMode>
        <EditorPaneFooterlessHarness editorGroups={editorGroups} terminalService={terminalService} />
      </StrictMode>,
    );

    await waitForSelector('[data-component="editor-groups-part"]', 10_000);
    await waitForSelector('[data-component="editor-pane"]', 10_000);
    await waitUntil(
      () => document.querySelectorAll('[data-editor-layout-tab="true"]').length >= 3,
      10_000,
      () => `Timed out waiting for flexlayout tabs; saw ${document.querySelectorAll('[data-editor-layout-tab="true"]').length}.`,
    );
    await waitUntil(
      () => statusBarKind() === "file",
      10_000,
      () => `Timed out waiting for initial file status bar; saw ${statusBarKind() ?? "<missing>"}.`,
    );
    await animationFrame();

    const editorPaneProbe = collectEditorPaneProbe();
    const statusInitialKind = statusBarKind();
    const fileTextBeforeSwitch = statusBarText();

    await activateLayoutTab(terminalTabId);
    await waitUntil(
      () => statusBarKind() === "terminal",
      5_000,
      () => `Timed out switching status bar to terminal; saw ${statusBarKind() ?? "<missing>"}.`,
    );
    const statusAfterTerminalKind = statusBarKind();
    const terminalText = statusBarText();

    await activateLayoutTab(fileOne.id);
    await waitUntil(
      () => statusBarKind() === "file",
      5_000,
      () => `Timed out switching status bar back to file; saw ${statusBarKind() ?? "<missing>"}.`,
    );
    const statusAfterFileKind = statusBarKind();
    const fileTextAfterSwitch = statusBarText();

    const contextMenuProbe = await exerciseContextMenu(fileOne.id);
    const middleClickProbe = await exerciseMiddleClickClose(fileTwo.id);
    const statusBarProbe = collectStatusBarProbe({
      initialKind: statusInitialKind,
      afterTerminalKind: statusAfterTerminalKind,
      afterFileKind: statusAfterFileKind,
      fileText: fileTextAfterSwitch || fileTextBeforeSwitch,
      terminalText,
    });

    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const errors = [
      ...fatalErrors,
      ...validateSmokeResult({
        editorPane: editorPaneProbe,
        statusBar: statusBarProbe,
        contextMenu: contextMenuProbe,
        middleClick: middleClickProbe,
      }),
    ];

    publishResult({
      ok: errors.length === 0,
      errors,
      editorPane: editorPaneProbe,
      statusBar: statusBarProbe,
      contextMenu: contextMenuProbe,
      middleClick: middleClickProbe,
      reason: errors[0],
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function EditorPaneFooterlessHarness({
  editorGroups,
  terminalService,
}: {
  editorGroups: ReturnType<typeof createEditorGroupsService>;
  terminalService: ReturnType<typeof createTerminalService>;
}): JSX.Element {
  const [editorGroupsState, setEditorGroupsState] = useState(() => editorGroups.getState());
  const [terminalTabs, setTerminalTabs] = useState(() => terminalService.getState().tabs);
  const [panes, setPanes] = useState<EditorPaneState[]>(initialPanes);

  useEffect(() => editorGroups.subscribe((nextState) => setEditorGroupsState(nextState)), [editorGroups]);
  useEffect(() => terminalService.subscribe((nextState) => setTerminalTabs(nextState.tabs)), [terminalService]);

  const statusBarActiveItem = useMemo(() => resolveStatusBarActiveItem({
    activeGroupId: editorGroupsState.activeGroupId,
    groups: editorGroupsState.groups,
    panes,
    terminalTabs,
  }), [editorGroupsState.activeGroupId, editorGroupsState.groups, panes, terminalTabs]);

  const handleCloseTab = (groupId: string, tabId: EditorTabId): void => {
    closeCalls.push(`${groupId}:${tabId}`);
    setPanes((currentPanes) => currentPanes.map((pane) => {
      if (pane.id !== groupId) {
        return pane;
      }

      const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId = pane.activeTabId === tabId ? tabs[0]?.id ?? null : pane.activeTabId;
      return { ...pane, tabs, activeTabId };
    }));
    editorGroups.getState().closeTab(groupId, tabId);
    if (tabId === terminalTabId) {
      terminalService.getState().closeTab(tabId);
    }
  };

  return (
    <main
      data-editor-pane-footerless-runtime-harness="true"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <section data-slot="editor-area" className="min-h-0 flex-1">
        <EditorGroupsPart
          activeGroupId={editorGroupsState.activeGroupId}
          groups={editorGroupsState.groups}
          editorGroupsService={editorGroups}
          terminalService={terminalService}
          layoutSnapshot={editorGroupsState.layoutSnapshot}
          model={editorGroupsState.model}
          activeWorkspaceId={workspaceId}
          activeWorkspaceName="Footerless Runtime"
          panes={panes}
          activePaneId={editorGroupsState.activeGroupId ?? DEFAULT_EDITOR_GROUP_ID}
          onActivatePane={(paneId) => editorGroups.getState().activateGroup(paneId)}
          onSplitRight={() => splitRightCalls.push("toolbar")}
          onSplitTabRight={(sourceGroupId, tabId) => {
            splitRightCalls.push(`${sourceGroupId}:${tabId}`);
          }}
          onCloseTab={handleCloseTab}
          onCopyTabPath={(tab, pathKind) => {
            if (pathKind === "relative") {
              copyRelativePathCalls.push(`${tab.path}:${pathKind}`);
            }
          }}
          onRevealTabInFinder={() => {}}
          onSaveTab={() => {}}
          onChangeContent={(tabId, content) => {
            setPanes((currentPanes) => currentPanes.map((pane) => ({
              ...pane,
              tabs: pane.tabs.map((tab) => tab.id === tabId ? { ...tab, content, dirty: true } : tab),
            })));
          }}
        />
      </section>
      <StatusBarPart activeItem={statusBarActiveItem} />
    </main>
  );
}

function resolveStatusBarActiveItem({
  activeGroupId,
  groups,
  panes,
  terminalTabs,
}: {
  activeGroupId: string | null;
  groups: readonly EditorGroup[];
  panes: readonly EditorPaneState[];
  terminalTabs: readonly TerminalTab[];
}): StatusBarActiveItem {
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null;
  const activeGroupTab = activeGroup?.tabs.find((tab) => tab.id === activeGroup.activeTabId) ?? null;

  if (!activeGroupTab) {
    return { kind: "empty" };
  }

  if (activeGroupTab.kind === "file") {
    const activeEditorTab = findEditorTab(panes, activeGroupTab.id);
    return activeEditorTab
      ? {
          kind: "file",
          lspStatus: activeEditorTab.lspStatus,
          diagnostics: activeEditorTab.diagnostics,
          language: activeEditorTab.language ?? activeEditorTab.monacoLanguage,
        }
      : {
          kind: "file",
          lspStatus: null,
          diagnostics: [],
          language: null,
        };
  }

  if (activeGroupTab.kind === "terminal") {
    const terminalTab = terminalTabs.find((tab) => tab.id === activeGroupTab.id) ?? null;
    return {
      kind: "terminal",
      shell: terminalTab?.shell ?? null,
      cwd: terminalTab?.cwd ?? workspaceRoot,
      pid: terminalTab?.pid ?? null,
    };
  }

  return {
    kind: activeGroupTab.kind === "diff" ? "diff" : "preview",
    label: activeGroupTab.title,
  };
}

function findEditorTab(panes: readonly EditorPaneState[], tabId: string): EditorTab | null {
  for (const pane of panes) {
    const tab = pane.tabs.find((candidate) => candidate.id === tabId);
    if (tab) {
      return tab;
    }
  }
  return null;
}

function collectEditorPaneProbe(): EditorPaneFooterlessRuntimeSmokeResult["editorPane"] {
  const editorPane = document.querySelector<HTMLElement>('[data-component="editor-pane"]');
  return {
    mounted: editorPane !== null,
    internalTablistCount: editorPane?.querySelectorAll('[role="tablist"]').length ?? -1,
    internalTabCount: editorPane?.querySelectorAll('[role="tab"]').length ?? -1,
    internalTabActionCount: editorPane?.querySelectorAll('[data-action="editor-activate-tab"], [data-editor-tab-title-active], [data-component="editor-tab-strip"], [data-editor-tab-list]').length ?? -1,
    flexlayoutTabCount: document.querySelectorAll('[data-editor-layout-tab="true"]').length,
  };
}

function collectStatusBarProbe({
  initialKind,
  afterTerminalKind,
  afterFileKind,
  fileText,
  terminalText,
}: {
  initialKind: string | null;
  afterTerminalKind: string | null;
  afterFileKind: string | null;
  fileText: string;
  terminalText: string;
}): EditorPaneFooterlessRuntimeSmokeResult["statusBar"] {
  const statusBar = document.querySelector<HTMLElement>('[data-slot="status-bar"]');
  return {
    mounted: statusBar !== null,
    separateFromEditorPane: statusBar?.closest('[data-component="editor-pane"]') === null,
    separateFromEditorGroupsPart: statusBar?.closest('[data-component="editor-groups-part"]') === null,
    initialKind,
    afterTerminalKind,
    afterFileKind,
    fileText,
    terminalText,
  };
}

async function exerciseContextMenu(tabId: string): Promise<EditorPaneFooterlessRuntimeSmokeResult["contextMenu"]> {
  const tab = await waitForLayoutTab(tabId);
  dispatchContextMenu(tab);
  const menu = await waitForSelector('[data-tab-context-menu="true"]', 5_000);
  const menuItemIds = collectMenuItemIds(menu);

  const copyRelativeItem = menu.querySelector<HTMLElement>('[data-menu-item-id="copy-relative-path"]');
  copyRelativeItem?.click();
  await waitUntil(
    () => copyRelativePathCalls.length === 1,
    2_000,
    () => `Timed out waiting for copy-relative-path callback; calls=${copyRelativePathCalls.join(",")}.`,
  );

  const tabForSplit = await waitForLayoutTab(tabId);
  dispatchContextMenu(tabForSplit);
  const splitMenu = await waitForSelector('[data-tab-context-menu="true"]', 5_000);
  const splitRightItem = splitMenu.querySelector<HTMLElement>('[data-menu-item-id="split-right"]');
  splitRightItem?.click();
  await waitUntil(
    () => splitRightCalls.includes(`${DEFAULT_EDITOR_GROUP_ID}:${tabId}`),
    2_000,
    () => `Timed out waiting for split-right callback; calls=${splitRightCalls.join(",")}.`,
  );

  return {
    opened: true,
    menuItemIds,
    copyRelativePathCalls: [...copyRelativePathCalls],
    splitRightCalls: [...splitRightCalls].filter((call) => call !== "toolbar"),
  };
}

async function exerciseMiddleClickClose(tabId: string): Promise<EditorPaneFooterlessRuntimeSmokeResult["middleClick"]> {
  const tab = await waitForLayoutTab(tabId);
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 1,
    buttons: 4,
    view: window,
  });
  tab.dispatchEvent(event);
  await waitUntil(
    () => document.querySelector(`[data-editor-layout-tab-id="${CSS.escape(tabId)}"]`) === null,
    5_000,
    () => `Timed out waiting for ${tabId} to close; closeCalls=${closeCalls.join(",")}.`,
  );

  return {
    attempted: true,
    tabRemoved: document.querySelector(`[data-editor-layout-tab-id="${CSS.escape(tabId)}"]`) === null,
    closeCalls: [...closeCalls],
  };
}

async function activateLayoutTab(tabId: string): Promise<void> {
  const tab = await waitForLayoutTab(tabId);
  tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" }));
  tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window }));
  tab.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, view: window }));
  tab.click();
  await animationFrame();
}

async function waitForLayoutTab(tabId: string): Promise<HTMLElement> {
  return waitForSelector(`[data-editor-layout-tab-id="${CSS.escape(tabId)}"]`, 5_000);
}

function dispatchContextMenu(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    buttons: 2,
    clientX: 96,
    clientY: 48,
    view: window,
  }));
}

function collectMenuItemIds(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll<HTMLElement>("[data-menu-item-id]"))
    .map((item) => item.dataset.menuItemId ?? "")
    .filter(Boolean);
}

function statusBarKind(): string | null {
  return document.querySelector<HTMLElement>('[data-slot="status-bar"]')?.dataset.statusBarActiveKind ?? null;
}

function statusBarText(): string {
  return document.querySelector<HTMLElement>('[data-slot="status-bar"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function validateSmokeResult({
  editorPane,
  statusBar,
  contextMenu,
  middleClick,
}: Omit<EditorPaneFooterlessRuntimeSmokeResult, "ok" | "errors" | "reason">): string[] {
  const errors: string[] = [];
  if (!editorPane.mounted) {
    errors.push("EditorPane did not mount for the active file tab.");
  }
  if (editorPane.internalTablistCount !== 0) {
    errors.push(`EditorPane still contains ${editorPane.internalTablistCount} internal tablist(s).`);
  }
  if (editorPane.internalTabCount !== 0) {
    errors.push(`EditorPane still contains ${editorPane.internalTabCount} internal tab role element(s).`);
  }
  if (editorPane.internalTabActionCount !== 0) {
    errors.push(`EditorPane still contains ${editorPane.internalTabActionCount} internal tab action marker(s).`);
  }
  if (editorPane.flexlayoutTabCount < 3) {
    errors.push(`Expected at least 3 flexlayout tab DOM labels, saw ${editorPane.flexlayoutTabCount}.`);
  }
  if (!statusBar.mounted) {
    errors.push("StatusBarPart did not mount with data-slot=status-bar.");
  }
  if (!statusBar.separateFromEditorPane) {
    errors.push("Status bar is nested inside EditorPane; it must be a separate workbench slot.");
  }
  if (!statusBar.separateFromEditorGroupsPart) {
    errors.push("Status bar is nested inside EditorGroupsPart; it must be mounted separately below the editor area.");
  }
  if (statusBar.initialKind !== "file" || statusBar.afterFileKind !== "file") {
    errors.push(`Expected file status before/after file tab activation, saw initial=${statusBar.initialKind}, afterFile=${statusBar.afterFileKind}.`);
  }
  if (statusBar.afterTerminalKind !== "terminal") {
    errors.push(`Expected terminal status after activating terminal flexlayout tab, saw ${statusBar.afterTerminalKind}.`);
  }
  if (!statusBar.fileText.includes("LSP: ready") || !statusBar.fileText.includes("TypeScript")) {
    errors.push(`File status text did not include LSP/language details: ${statusBar.fileText}`);
  }
  if (!statusBar.terminalText.includes("zsh") || !statusBar.terminalText.includes("nexus-footerless-runtime")) {
    errors.push(`Terminal status text did not include shell/cwd details: ${statusBar.terminalText}`);
  }
  if (!contextMenu.opened) {
    errors.push("Context menu did not open from flexlayout tab DOM.");
  }
  for (const requiredItem of ["close", "copy-relative-path", "split-right"]) {
    if (!contextMenu.menuItemIds.includes(requiredItem)) {
      errors.push(`Context menu is missing ${requiredItem}; saw ${contextMenu.menuItemIds.join(",")}.`);
    }
  }
  if (contextMenu.copyRelativePathCalls.join("|") !== "src/footerless-one.ts:relative") {
    errors.push(`Context menu copy-relative-path callback mismatch: ${contextMenu.copyRelativePathCalls.join(",")}.`);
  }
  if (contextMenu.splitRightCalls.join("|") !== `${DEFAULT_EDITOR_GROUP_ID}:footerless_file_one`) {
    errors.push(`Context menu split-right callback mismatch: ${contextMenu.splitRightCalls.join(",")}.`);
  }
  if (!middleClick.attempted || !middleClick.tabRemoved) {
    errors.push(`Middle-click close did not remove footerless_file_two; closeCalls=${middleClick.closeCalls.join(",")}.`);
  }
  return errors;
}

function createEditorTab({
  id,
  path,
  title,
  dirty,
  diagnostics,
}: {
  id: EditorTabId;
  path: string;
  title: string;
  dirty: boolean;
  diagnostics: LspDiagnostic[];
}): EditorTab {
  return {
    id,
    workspaceId,
    path,
    title,
    kind: "file",
    content: `export const ${id} = true;\n`,
    savedContent: dirty ? "" : `export const ${id} = true;\n`,
    version: "v1",
    dirty,
    saving: false,
    errorMessage: null,
    language: "typescript",
    monacoLanguage: "typescript",
    lspDocumentVersion: 1,
    diagnostics,
    lspStatus: {
      language: "typescript",
      state: "ready",
      serverName: "typescript-language-server",
      message: "ready",
      updatedAt: "2026-04-29T00:00:00.000Z",
    },
  };
}

function editorGroupTabFromEditorTab(tab: EditorTab): EditorGroupTab {
  return {
    id: tab.id,
    title: tab.title,
    kind: "file",
    workspaceId: tab.workspaceId,
    resourcePath: tab.path,
  };
}

class FakeTerminalLike implements TerminalServiceTerminalLike {
  private host: HTMLElement | null = null;
  private node: HTMLElement | null = null;

  public mount(parent: HTMLElement): boolean {
    this.detach();
    this.host = parent;
    this.node = document.createElement("div");
    this.node.setAttribute("data-fake-terminal", "true");
    this.node.textContent = "fake terminal";
    parent.append(this.node);
    return true;
  }

  public detach(): void {
    this.node?.remove();
    this.node = null;
    this.host = null;
  }

  public fit(): void {}
  public focus(): void {}
  public write(): void {}

  public dispose(): void {
    this.detach();
  }
}

function installConsoleCapture(): void {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    capturedConsoleMessages.push(message);
    originalWarn(...args);
  };
  window.addEventListener("error", (event) => {
    capturedErrors.push(event.message || stringifyErrorPart(event.error));
  });
  window.addEventListener("unhandledrejection", (event) => {
    capturedErrors.push(stringifyErrorPart(event.reason));
  });
}

function prepareDocument(rootElement: HTMLElement): void {
  document.documentElement.style.width = "1180px";
  document.documentElement.style.height = "760px";
  document.body.style.width = "1180px";
  document.body.style.height = "760px";
  document.body.style.margin = "0";
  rootElement.style.width = "1180px";
  rootElement.style.height = "760px";
}

async function waitForSelector(selector: string, timeoutMs: number): Promise<HTMLElement> {
  let latest: HTMLElement | null = null;
  await waitUntil(() => {
    latest = document.querySelector<HTMLElement>(selector);
    return latest !== null;
  }, timeoutMs, () => `Timed out waiting for selector ${selector}.`);
  return latest!;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: () => string): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await animationFrame();
  }
  throw new Error(message());
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
}

function failedResult(reason: string): EditorPaneFooterlessRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    editorPane: {
      mounted: false,
      internalTablistCount: -1,
      internalTabCount: -1,
      internalTabActionCount: -1,
      flexlayoutTabCount: -1,
    },
    statusBar: {
      mounted: false,
      separateFromEditorPane: false,
      separateFromEditorGroupsPart: false,
      initialKind: null,
      afterTerminalKind: null,
      afterFileKind: null,
      fileText: "",
      terminalText: "",
    },
    contextMenu: {
      opened: false,
      menuItemIds: [],
      copyRelativePathCalls: [],
      splitRightCalls: [],
    },
    middleClick: {
      attempted: false,
      tabRemoved: false,
      closeCalls: [],
    },
    reason,
  };
}

function stringifyErrorPart(part: unknown): string {
  if (part instanceof Error) {
    return `${part.message}\n${part.stack ?? ""}`;
  }
  if (typeof part === "string") {
    return part;
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function publishResult(result: EditorPaneFooterlessRuntimeSmokeResult): void {
  window.__nexusEditorPaneFooterlessRuntimeSmokeResult = result;
}
