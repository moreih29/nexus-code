import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

import { Actions, type IJsonRowNode, type IJsonTabNode } from "flexlayout-react";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import {
  DEFAULT_EDITOR_GROUP_ID,
  EDITOR_GROUP_TAB_COMPONENT,
  createEditorGroupsService,
  type EditorGroupsSerializedModel,
  type EditorGroupTab,
} from "../../src/renderer/services/editor-groups-service";
import type { EditorTab } from "../../src/renderer/services/editor-types";
import { EditorGroupsPart } from "../../src/renderer/parts/editor-groups";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";

interface EditorPopoutDisabledRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  modelSnapshot: {
    globalPopoutDisabled: boolean;
    globalFloatIconDisabled: boolean;
    tabsPopoutDisabled: boolean;
    subLayoutsRemoved: boolean;
  };
  runtimeDom: {
    mounted: boolean;
    tabPopoutIconCount: number;
    floatingWindowCount: number;
  };
  programmaticActions: {
    tearOffResult: string | null;
    popoutTabNoop: boolean;
    createPopoutNoop: boolean;
  };
  reason?: string;
}

declare global {
  interface Window {
    __nexusEditorPopoutDisabledRuntimeSmokeResult?: EditorPopoutDisabledRuntimeSmokeResult;
  }
}

const workspaceId = "ws_editor_popout_disabled" as WorkspaceId;
const groupTab: EditorGroupTab = {
  id: `${workspaceId}::src/popout-disabled.ts`,
  title: "popout-disabled.ts",
  kind: "file",
  workspaceId,
  resourcePath: "src/popout-disabled.ts",
};
const editorTab: EditorTab = {
  kind: "file",
  id: groupTab.id,
  workspaceId,
  path: "src/popout-disabled.ts",
  title: groupTab.title,
  content: "export const popoutDisabled = true;\n",
  savedContent: "export const popoutDisabled = true;\n",
  version: "v1",
  dirty: false,
  saving: false,
  errorMessage: null,
  language: "typescript",
  monacoLanguage: "typescript",
  lspDocumentVersion: 1,
  diagnostics: [],
  lspStatus: null,
};

void runSmoke();

async function runSmoke(): Promise<void> {
  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    const editorGroups = createEditorGroupsService();
    editorGroups.getState().openTab(DEFAULT_EDITOR_GROUP_ID, groupTab);

    const beforeProgrammaticActions = editorGroups.getState().serializeModel();
    const tearOffResult = editorGroups.getState().tearOffActiveTabToFloating();
    const afterTearOff = editorGroups.getState().serializeModel();
    const popoutTabResult = editorGroups.getState().model.doAction(Actions.popoutTab(groupTab.id, "float"));
    const afterPopoutTab = editorGroups.getState().serializeModel();
    const createPopoutResult = editorGroups.getState().model.doAction(Actions.createPopout(createBlockedPopoutLayout(), {
      x: 10,
      y: 10,
      width: 320,
      height: 180,
    }, "float"));
    const afterCreatePopout = editorGroups.getState().serializeModel();
    const state = editorGroups.getState();

    createRoot(rootElement).render(createElement(StrictMode, null, createElement(EditorGroupsPart, {
      activeGroupId: state.activeGroupId,
      activePaneId: DEFAULT_EDITOR_GROUP_ID,
      activeWorkspaceId: null,
      activeWorkspaceName: "Popout Disabled",
      groups: state.groups,
      layoutSnapshot: state.layoutSnapshot,
      model: state.model,
      panes: [{ id: DEFAULT_EDITOR_GROUP_ID, tabs: [editorTab], activeTabId: editorTab.id }],
      onActivatePane() {},
      onChangeContent() {},
      onCloseTab() {},
      onCopyTabPath() {},
      onRevealTabInFinder() {},
      onSaveTab() {},
      onSplitRight() {},
      onSplitTabRight() {},
    })));

    await waitForSelector('[data-component="editor-groups-part"]', 5_000);
    await animationFrame();

    const snapshot = editorGroups.getState().serializeModel();
    const tabs = collectTabs(snapshot.layout);
    const runtimeDom = {
      mounted: document.querySelector('[data-component="editor-groups-part"]') !== null,
      tabPopoutIconCount: document.querySelectorAll(".flexlayout__tab_toolbar_button-float,.flexlayout__border_toolbar_button-float").length,
      floatingWindowCount: document.querySelectorAll(".flexlayout__float_window,.flexlayout__floating_window_content").length,
    };
    const modelSnapshot = {
      globalPopoutDisabled: snapshot.global?.tabEnablePopout === false,
      globalFloatIconDisabled: snapshot.global?.tabEnablePopoutFloatIcon === false,
      tabsPopoutDisabled: tabs.length > 0 && tabs.every((tab) =>
        tab.enablePopout === false && tab.enablePopoutFloatIcon === false
      ),
      subLayoutsRemoved: snapshot.subLayouts === undefined,
    };
    const programmaticActions = {
      tearOffResult,
      popoutTabNoop: popoutTabResult === undefined && sameSnapshot(afterTearOff, beforeProgrammaticActions) && sameSnapshot(afterPopoutTab, beforeProgrammaticActions),
      createPopoutNoop: createPopoutResult === undefined && sameSnapshot(afterCreatePopout, beforeProgrammaticActions),
    };
    const ok =
      modelSnapshot.globalPopoutDisabled &&
      modelSnapshot.globalFloatIconDisabled &&
      modelSnapshot.tabsPopoutDisabled &&
      modelSnapshot.subLayoutsRemoved &&
      runtimeDom.mounted &&
      runtimeDom.tabPopoutIconCount === 0 &&
      runtimeDom.floatingWindowCount === 0 &&
      programmaticActions.tearOffResult === null &&
      programmaticActions.popoutTabNoop &&
      programmaticActions.createPopoutNoop;

    publishResult({
      ok,
      errors: [],
      modelSnapshot,
      runtimeDom,
      programmaticActions,
      reason:
        (!modelSnapshot.globalPopoutDisabled ? "Global tabEnablePopout was not false." : undefined) ??
        (!modelSnapshot.globalFloatIconDisabled ? "Global tabEnablePopoutFloatIcon was not false." : undefined) ??
        (!modelSnapshot.tabsPopoutDisabled ? "At least one serialized tab still allows popout." : undefined) ??
        (!modelSnapshot.subLayoutsRemoved ? "Serialized model still contains flexlayout subLayouts." : undefined) ??
        (!runtimeDom.mounted ? "EditorGroupsPart did not mount." : undefined) ??
        (runtimeDom.tabPopoutIconCount !== 0 ? `Found ${runtimeDom.tabPopoutIconCount} flexlayout popout icons.` : undefined) ??
        (runtimeDom.floatingWindowCount !== 0 ? `Found ${runtimeDom.floatingWindowCount} flexlayout floating windows.` : undefined) ??
        (programmaticActions.tearOffResult !== null ? "tearOffActiveTabToFloating returned a tab id." : undefined) ??
        (!programmaticActions.popoutTabNoop ? "Actions.popoutTab changed the editor groups model." : undefined) ??
        (!programmaticActions.createPopoutNoop ? "Actions.createPopout changed the editor groups model." : undefined),
    });
  } catch (error) {
    publishResult(failedResult(error instanceof Error ? error.message : String(error)));
  }
}

function createBlockedPopoutLayout(): IJsonRowNode {
  return {
    type: "row",
    children: [
      {
        type: "tabset",
        id: "group_blocked_popout_runtime",
        children: [
          {
            type: "tab",
            id: "tab_blocked_popout_runtime",
            name: "blocked-popout.ts",
            component: EDITOR_GROUP_TAB_COMPONENT,
          },
        ],
      },
    ],
  };
}

function collectTabs(row: IJsonRowNode): IJsonTabNode[] {
  return (row.children ?? []).flatMap((child) =>
    child.type === "tabset" ? child.children ?? [] : collectTabs(child)
  );
}

function sameSnapshot(left: EditorGroupsSerializedModel, right: EditorGroupsSerializedModel): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function waitForSelector(selector: string, timeoutMs: number): Promise<void> {
  await waitUntil(
    () => document.querySelector(selector) !== null,
    timeoutMs,
    () => `Timed out waiting for selector ${selector}.`,
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: () => string): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error(message());
}

async function animationFrame(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
}

function publishResult(result: EditorPopoutDisabledRuntimeSmokeResult): void {
  window.__nexusEditorPopoutDisabledRuntimeSmokeResult = result;
}

function failedResult(reason: string): EditorPopoutDisabledRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    modelSnapshot: {
      globalPopoutDisabled: false,
      globalFloatIconDisabled: false,
      tabsPopoutDisabled: false,
      subLayoutsRemoved: false,
    },
    runtimeDom: {
      mounted: false,
      tabPopoutIconCount: -1,
      floatingWindowCount: -1,
    },
    programmaticActions: {
      tearOffResult: null,
      popoutTabNoop: false,
      createPopoutNoop: false,
    },
    reason,
  };
}
