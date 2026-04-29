import { StrictMode, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Actions } from "flexlayout-react";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import { installMonacoEnvironment } from "../../src/renderer/editor/monaco-environment";
import { EditorGroupsPart } from "../../src/renderer/parts/editor-groups/EditorGroupsPart";
import {
  DEFAULT_EDITOR_GROUP_ID,
  createEditorGroupsService,
  type EditorGroup,
  type EditorGroupId,
  type EditorGroupTab,
  type EditorGroupsSerializedModel,
  type EditorGroupsServiceStore,
} from "../../src/renderer/services/editor-groups-service";
import type { EditorPaneState, EditorTab } from "../../src/renderer/services/editor-types";
import { createTerminalService, type TerminalServiceStore } from "../../src/renderer/services/terminal-service";
import {
  createWorkspaceService,
  getWorkspaceLayoutStorageKey,
  type WorkspaceLayoutSnapshot,
} from "../../src/renderer/services/workspace-service";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import "@xterm/xterm/css/xterm.css";

type ScenarioStatus = "pass" | "fail";

type EditorEmptyGroupPolicyScenarioId =
  | "closeCenterRelayout"
  | "closeAllFinalEmpty"
  | "splitEmptyNoop"
  | "splitCommandDuplicate"
  | "splitSizingAuto"
  | "finalEmptyPersistence";

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface RuntimeGroupSnapshot {
  groupId: string;
  tabCount: number;
  activeTabId: string | null;
  rect: RectSnapshot;
  nonzero: boolean;
  contained: boolean;
}

interface ScenarioResult {
  status: ScenarioStatus;
  reason?: string;
}

interface CloseCenterRelayoutResult extends ScenarioResult {
  beforeGroupIds: string[];
  afterGroupIds: string[];
  centerRemoved: boolean;
  remainingGroupsNonzero: boolean;
  remainingGroupsContained: boolean;
  layoutFillsContainer: boolean;
  areaCoverageRatio: number;
  groups: RuntimeGroupSnapshot[];
}

interface CloseAllFinalEmptyResult extends ScenarioResult {
  groupCount: number;
  finalGroupId: string | null;
  finalGroupTabCount: number | null;
  placeholderVisible: boolean;
  placeholderRole: string | null;
  placeholderAriaLabel: string | null;
  serializedTabSetCount: number;
  finalTabSetPreserved: boolean;
}

interface SplitEmptyNoopResult extends ScenarioResult {
  returnedGroupId: string | null;
  modelUnchanged: boolean;
  groupCount: number;
  finalGroupTabCount: number | null;
}

interface SplitCommandDuplicateResult extends ScenarioResult {
  splitGroupId: string | null;
  sourceGroupTabs: string[];
  targetGroupTabs: string[];
  logicalTabOccurrences: number;
  logicalPathOccurrences: number;
  activeGroupId: string | null;
  sourceRetainedTab: boolean;
  targetDuplicatedTab: boolean;
}

interface SplitSizingAutoResult extends ScenarioResult {
  firstSplitGroupId: string | null;
  secondSplitGroupId: string | null;
  firstSplitWeights: number[] | null;
  resizedWeightsBeforeSecondSplit: number[] | null;
  secondSplitWeights: number[] | null;
  firstSplitEqual: boolean;
  userResizeObserved: boolean;
  activeGroupHalvedAfterResize: boolean;
}

interface FinalEmptyPersistenceResult extends ScenarioResult {
  serializedTabSetCount: number;
  serializedFinalTabSetHasNoTabs: boolean;
  restoredGroupCount: number;
  restoredFinalGroupTabCount: number | null;
  serviceRoundTripLossless: boolean;
  workspaceStorageLossless: boolean;
  corruptLayoutIsNull: boolean;
  fallbackGroupCount: number;
  fallbackFinalGroupTabCount: number | null;
}

interface EditorEmptyGroupPolicyRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarios: {
    closeCenterRelayout: CloseCenterRelayoutResult;
    closeAllFinalEmpty: CloseAllFinalEmptyResult;
    splitEmptyNoop: SplitEmptyNoopResult;
    splitCommandDuplicate: SplitCommandDuplicateResult;
    splitSizingAuto: SplitSizingAutoResult;
    finalEmptyPersistence: FinalEmptyPersistenceResult;
  };
  reason?: string;
}

interface RuntimeHarnessServices {
  editorGroups: EditorGroupsServiceStore;
  terminalService: TerminalServiceStore;
}

interface FinalEmptyWorkspaceLayout extends WorkspaceLayoutSnapshot {
  schema: "editor-empty-group-policy-runtime/v1";
  workspaceId: string;
  editorGroups: EditorGroupsSerializedModel;
}

declare global {
  interface Window {
    __nexusEditorEmptyGroupPolicyRuntimeSmokeResult?: EditorEmptyGroupPolicyRuntimeSmokeResult;
  }
}

const workspaceId = "ws_empty_group_policy_runtime" as WorkspaceId;
const workspaceRoot = "/tmp/nexus-empty-group-policy-runtime";
const fixtureDimensions = { width: 900, height: 420 };
const rectTolerancePx = 8;
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;

installMonacoEnvironment();
installConsoleCapture();
void runSmoke();

async function runSmoke(): Promise<void> {
  let root: Root | null = null;

  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);
    clearFixtureStorage();

    const mountedServices: RuntimeHarnessServices = {
      editorGroups: createThreePaneService(),
      terminalService: createTerminalService(),
    };

    root = createRoot(rootElement);
    root.render(
      <StrictMode>
        <EditorEmptyGroupPolicyWorkbench services={mountedServices} />
      </StrictMode>,
    );

    await waitUntil(
      () => mountedServices.editorGroups.getState().groups.length === 3 && collectMountedGroupSnapshots(rootElement, mountedServices.editorGroups).length === 3,
      10_000,
      () => `Timed out waiting for initial 3-pane editor state; groups=${mountedServices.editorGroups.getState().groups.map((group) => `${group.id}:${group.tabs.length}`).join(",")}`,
    );
    await settleFor(150);

    const closeCenterRelayout = await verifyCloseCenterRelayout(rootElement, mountedServices.editorGroups);
    const closeAllFinalEmpty = await verifyCloseAllFinalEmpty(rootElement, mountedServices.editorGroups);
    const splitEmptyNoop = verifySplitEmptyNoop(mountedServices.editorGroups);
    const splitCommandDuplicate = verifySplitCommandDuplicatesActiveTab();
    const splitSizingAuto = verifySplitSizingAutoMode();
    const finalEmptyPersistence = verifyFinalEmptyPersistenceRoundTrip();

    root.unmount();
    root = null;

    const scenarios = {
      closeCenterRelayout,
      closeAllFinalEmpty,
      splitEmptyNoop,
      splitCommandDuplicate,
      splitSizingAuto,
      finalEmptyPersistence,
    };
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const scenarioErrors = Object.entries(scenarios)
      .filter(([, scenario]) => scenario.status !== "pass")
      .map(([id, scenario]) => `${id}: ${scenario.reason ?? "failed"}`);
    const errors = [...fatalErrors, ...scenarioErrors];

    publishResult({
      ok: errors.length === 0,
      errors,
      scenarios,
      reason: errors[0],
    });
  } catch (error) {
    root?.unmount();
    publishResult(failedResult(stringifyErrorPart(error)));
  } finally {
    clearFixtureStorage();
  }
}

function EditorEmptyGroupPolicyWorkbench({ services }: { services: RuntimeHarnessServices }): JSX.Element {
  const groups = useStore(services.editorGroups, (state) => state.groups);
  const activeGroupId = useStore(services.editorGroups, (state) => state.activeGroupId);
  const layoutSnapshot = useStore(services.editorGroups, (state) => state.layoutSnapshot);
  const model = useStore(services.editorGroups, (state) => state.model);
  const panes = useMemo(() => panesFromGroups(groups), [groups]);

  return (
    <main
      data-fixture="editor-empty-group-policy-runtime"
      className="bg-background p-4 text-foreground"
      style={{ width: fixtureDimensions.width + 48, height: fixtureDimensions.height + 48 }}
    >
      <section
        data-empty-group-policy-scenario="mounted-editor"
        className="overflow-hidden rounded border border-border bg-background"
        style={{ width: fixtureDimensions.width, height: fixtureDimensions.height }}
      >
        <EditorGroupsPart
          activeGroupId={activeGroupId}
          groups={groups}
          editorGroupsService={services.editorGroups}
          terminalService={services.terminalService}
          layoutSnapshot={layoutSnapshot}
          model={model}
          activeWorkspaceId={workspaceId}
          activeWorkspaceName="Empty Group Policy"
          panes={panes}
          activePaneId={activeGroupId ?? DEFAULT_EDITOR_GROUP_ID}
          onActivatePane={(paneId) => services.editorGroups.getState().activateGroup(paneId)}
          onSplitRight={() => {
            const state = services.editorGroups.getState();
            const sourceGroupId = state.activeGroupId ?? state.groups[0]?.id ?? DEFAULT_EDITOR_GROUP_ID;
            state.splitGroup({ sourceGroupId, direction: "right" });
          }}
          onCloseTab={(groupId, tabId) => services.editorGroups.getState().closeTab(groupId, tabId)}
          onSaveTab={() => {}}
          onChangeContent={() => {}}
        />
      </section>
    </main>
  );
}

async function verifyCloseCenterRelayout(
  rootElement: HTMLElement,
  service: EditorGroupsServiceStore,
): Promise<CloseCenterRelayoutResult> {
  const beforeGroupIds = service.getState().groups.map((group) => group.id);
  service.getState().closeTab("group_center", "tab_center");

  await waitUntil(
    () => {
      const groups = service.getState().groups;
      const mountedGroups = collectMountedGroupSnapshots(rootElement, service);
      return groups.length === 2 &&
        groups.every((group) => group.id !== "group_center") &&
        mountedGroups.length === 2 &&
        mountedGroups.every((group) => group.groupId !== "group_center");
    },
    8_000,
    () => `Timed out waiting for center group deletion; groups=${service.getState().groups.map((group) => `${group.id}:${group.tabs.length}`).join(",")}`,
  );
  await settleFor(150);

  const afterGroupIds = service.getState().groups.map((group) => group.id);
  const layoutElement = rootElement.querySelector<HTMLElement>(".flexlayout__layout");
  const scenarioElement = rootElement.querySelector<HTMLElement>('[data-empty-group-policy-scenario="mounted-editor"]');
  const groups = collectMountedGroupSnapshots(rootElement, service);
  const centerRemoved = !afterGroupIds.includes("group_center") && groups.every((group) => group.groupId !== "group_center");
  const remainingGroupsNonzero = groups.length === 2 && groups.every((group) => group.nonzero);
  const remainingGroupsContained = groups.length === 2 && groups.every((group) => group.contained);
  const layoutRect = layoutElement ? rectSnapshot(layoutElement.getBoundingClientRect()) : null;
  const scenarioRect = scenarioElement ? rectSnapshot(scenarioElement.getBoundingClientRect()) : null;
  const layoutFillsContainer = Boolean(layoutRect && scenarioRect && rectSizesMatch(layoutRect, scenarioRect, rectTolerancePx));
  const areaCoverageRatio = layoutRect
    ? roundRectNumber(groups.reduce((sum, group) => sum + group.rect.width * group.rect.height, 0) / Math.max(1, layoutRect.width * layoutRect.height))
    : 0;
  const status = beforeGroupIds.length === 3 &&
    sameStringArray(afterGroupIds, ["group_left", "group_right"]) &&
    centerRemoved &&
    remainingGroupsNonzero &&
    remainingGroupsContained &&
    layoutFillsContainer &&
    areaCoverageRatio >= 0.85
    ? "pass"
    : "fail";

  return {
    status,
    beforeGroupIds,
    afterGroupIds,
    centerRemoved,
    remainingGroupsNonzero,
    remainingGroupsContained,
    layoutFillsContainer,
    areaCoverageRatio,
    groups,
    reason: status === "pass"
      ? undefined
      : `Expected center group deletion and two nonzero relaid-out groups; before=${beforeGroupIds.join(",")}, after=${afterGroupIds.join(",")}, ratio=${areaCoverageRatio}`,
  };
}

async function verifyCloseAllFinalEmpty(
  rootElement: HTMLElement,
  service: EditorGroupsServiceStore,
): Promise<CloseAllFinalEmptyResult> {
  const closeTargets = service.getState().groups.flatMap((group) =>
    group.tabs.map((tab) => ({ groupId: group.id, tabId: tab.id }))
  );

  for (const target of closeTargets) {
    service.getState().closeTab(target.groupId, target.tabId);
  }

  await waitUntil(
    () => {
      const groups = service.getState().groups;
      return groups.length === 1 &&
        groups[0]?.tabs.length === 0 &&
        rootElement.querySelector('[data-editor-empty-group-placeholder="true"]') !== null;
    },
    8_000,
    () => `Timed out waiting for final empty group placeholder; groups=${service.getState().groups.map((group) => `${group.id}:${group.tabs.length}`).join(",")}`,
  );
  await settleFor(100);

  const groups = service.getState().groups;
  const finalGroup = groups[0] ?? null;
  const placeholder = rootElement.querySelector<HTMLElement>('[data-editor-empty-group-placeholder="true"]');
  const serializedTabSets = collectSerializedTabSets(service.getState().serializeModel());
  const finalTabSet = serializedTabSets[0] ?? null;
  const finalTabSetPreserved = serializedTabSets.length === 1 &&
    (finalTabSet?.children?.length ?? 0) === 0 &&
    finalTabSet?.enableDeleteWhenEmpty === false;
  const status = groups.length === 1 &&
    finalGroup?.tabs.length === 0 &&
    placeholder !== null &&
    placeholder.getAttribute("role") === "status" &&
    placeholder.getAttribute("aria-label") === "Empty editor group" &&
    finalTabSetPreserved
    ? "pass"
    : "fail";

  return {
    status,
    groupCount: groups.length,
    finalGroupId: finalGroup?.id ?? null,
    finalGroupTabCount: finalGroup?.tabs.length ?? null,
    placeholderVisible: placeholder !== null,
    placeholderRole: placeholder?.getAttribute("role") ?? null,
    placeholderAriaLabel: placeholder?.getAttribute("aria-label") ?? null,
    serializedTabSetCount: serializedTabSets.length,
    finalTabSetPreserved,
    reason: status === "pass"
      ? undefined
      : `Expected one empty final group with placeholder; groupCount=${groups.length}, tabCount=${finalGroup?.tabs.length ?? "missing"}, placeholder=${placeholder !== null}, tabsets=${serializedTabSets.length}`,
  };
}

function verifySplitEmptyNoop(service: EditorGroupsServiceStore): SplitEmptyNoopResult {
  const beforeSnapshot = service.getState().serializeModel();
  const finalGroup = service.getState().groups[0] ?? null;
  const returnedGroupId = finalGroup
    ? service.getState().splitGroup({
        sourceGroupId: finalGroup.id,
        direction: "right",
        targetGroupId: "group_should_not_exist",
      })
    : "missing-final-group";
  const afterSnapshot = service.getState().serializeModel();
  const groups = service.getState().groups;
  const modelUnchanged = sameJson(afterSnapshot, beforeSnapshot);
  const status = returnedGroupId === null && modelUnchanged && groups.length === 1 && groups[0]?.tabs.length === 0
    ? "pass"
    : "fail";

  return {
    status,
    returnedGroupId,
    modelUnchanged,
    groupCount: groups.length,
    finalGroupTabCount: groups[0]?.tabs.length ?? null,
    reason: status === "pass"
      ? undefined
      : `Expected splitGroup(empty) to return null and keep model unchanged; returned=${returnedGroupId}, unchanged=${modelUnchanged}, groups=${groups.length}`,
  };
}

function verifySplitCommandDuplicatesActiveTab(): SplitCommandDuplicateResult {
  const tab = createGroupTab("tab_duplicate_active", "src/duplicate-active.ts");
  const service = createEditorGroupsService({
    groups: [{ id: DEFAULT_EDITOR_GROUP_ID, tabs: [tab], activeTabId: tab.id }],
    activeGroupId: DEFAULT_EDITOR_GROUP_ID,
  });

  const splitGroupId = service.getState().splitGroup({
    sourceGroupId: DEFAULT_EDITOR_GROUP_ID,
    direction: "right",
    targetGroupId: "group_duplicate_right",
  });
  const state = service.getState();
  const sourceGroup = state.groups.find((group) => group.id === DEFAULT_EDITOR_GROUP_ID) ?? null;
  const targetGroup = splitGroupId ? state.groups.find((group) => group.id === splitGroupId) ?? null : null;
  const allTabs = state.groups.flatMap((group) => group.tabs);
  const logicalTabOccurrences = allTabs.filter((candidate) => candidate.id === tab.id).length;
  const logicalPathOccurrences = allTabs.filter((candidate) => candidate.resourcePath === tab.resourcePath).length;
  const sourceGroupTabs = sourceGroup?.tabs.map((candidate) => candidate.id) ?? [];
  const targetGroupTabs = targetGroup?.tabs.map((candidate) => candidate.id) ?? [];
  const sourceRetainedTab = sourceGroupTabs.includes(tab.id);
  const targetDuplicatedTab = targetGroupTabs.includes(tab.id);
  const status = splitGroupId === "group_duplicate_right" &&
    state.groups.length === 2 &&
    logicalTabOccurrences === 2 &&
    logicalPathOccurrences === 2 &&
    sourceRetainedTab &&
    targetDuplicatedTab &&
    state.activeGroupId === splitGroupId
    ? "pass"
    : "fail";

  return {
    status,
    splitGroupId,
    sourceGroupTabs,
    targetGroupTabs,
    logicalTabOccurrences,
    logicalPathOccurrences,
    activeGroupId: state.activeGroupId,
    sourceRetainedTab,
    targetDuplicatedTab,
    reason: status === "pass"
      ? undefined
      : `Expected active tab duplication into new group; splitGroupId=${splitGroupId}, occurrences=${logicalTabOccurrences}, source=${sourceGroupTabs.join(",")}, target=${targetGroupTabs.join(",")}`,
  };
}

function verifySplitSizingAutoMode(): SplitSizingAutoResult {
  const leftTab = createGroupTab("tab_left_sizing", "src/left-sizing.ts");
  const rightTab = createGroupTab("tab_right_sizing", "src/right-sizing.ts");
  const service = createEditorGroupsService({
    groups: [
      { id: "group_left", tabs: [leftTab], activeTabId: leftTab.id },
      { id: "group_right", tabs: [rightTab], activeTabId: rightTab.id },
    ],
    activeGroupId: "group_left",
  });

  const firstSplitGroupId = service.getState().splitGroup({
    sourceGroupId: "group_left",
    tabId: leftTab.id,
    direction: "right",
    targetGroupId: "group_left_first_split",
  });
  const firstSplitWeights = siblingWeightsForTabSets(service.getState().serializeModel(), [
    "group_left",
    "group_left_first_split",
    "group_right",
  ]);
  const firstSplitEqual = Boolean(firstSplitWeights && firstSplitWeights.length === 3 && new Set(firstSplitWeights).size === 1);

  service.getState().model.doAction(Actions.adjustWeights("root", [60, 20, 20]));
  const resizedWeightsBeforeSecondSplit = siblingWeightsForTabSets(service.getState().serializeModel(), [
    "group_left",
    "group_left_first_split",
    "group_right",
  ]);
  service.getState().activateGroup("group_left");
  const secondSplitGroupId = service.getState().splitGroup({
    sourceGroupId: "group_left",
    tabId: leftTab.id,
    direction: "right",
    targetGroupId: "group_left_second_split",
  });
  const secondSplitWeights = siblingWeightsForTabSets(service.getState().serializeModel(), [
    "group_left",
    "group_left_second_split",
    "group_left_first_split",
    "group_right",
  ]);
  const userResizeObserved = Boolean(resizedWeightsBeforeSecondSplit && sameNumberArray(resizedWeightsBeforeSecondSplit, [60, 20, 20]));
  const activeGroupHalvedAfterResize = Boolean(
    resizedWeightsBeforeSecondSplit &&
      secondSplitWeights &&
      secondSplitWeights.length === 4 &&
      Math.abs(secondSplitWeights[0]! - secondSplitWeights[1]!) <= 0.001 &&
      Math.abs((secondSplitWeights[0]! + secondSplitWeights[1]!) - resizedWeightsBeforeSecondSplit[0]!) <= 0.001 &&
      Math.abs(secondSplitWeights[2]! - resizedWeightsBeforeSecondSplit[1]!) <= 0.001 &&
      Math.abs(secondSplitWeights[3]! - resizedWeightsBeforeSecondSplit[2]!) <= 0.001,
  );
  const status = firstSplitGroupId === "group_left_first_split" &&
    secondSplitGroupId === "group_left_second_split" &&
    firstSplitEqual &&
    userResizeObserved &&
    activeGroupHalvedAfterResize
    ? "pass"
    : "fail";

  return {
    status,
    firstSplitGroupId,
    secondSplitGroupId,
    firstSplitWeights,
    resizedWeightsBeforeSecondSplit,
    secondSplitWeights,
    firstSplitEqual,
    userResizeObserved,
    activeGroupHalvedAfterResize,
    reason: status === "pass"
      ? undefined
      : `Expected splitSizing auto equal first split then halved resized active group; first=${JSON.stringify(firstSplitWeights)}, resized=${JSON.stringify(resizedWeightsBeforeSecondSplit)}, second=${JSON.stringify(secondSplitWeights)}`,
  };
}

function verifyFinalEmptyPersistenceRoundTrip(): FinalEmptyPersistenceResult {
  const workspaceLayoutId = "ws_empty_group_policy_persist" as WorkspaceId;
  const corruptWorkspaceId = "ws_empty_group_policy_corrupt" as WorkspaceId;
  const workspaceKey = getWorkspaceLayoutStorageKey(workspaceLayoutId);
  const corruptKey = getWorkspaceLayoutStorageKey(corruptWorkspaceId);

  localStorage.removeItem(workspaceKey);
  localStorage.removeItem(corruptKey);

  const emptyStore = createEditorGroupsService();
  const emptySnapshot = emptyStore.getState().serializeModel();
  const layout: FinalEmptyWorkspaceLayout = {
    schema: "editor-empty-group-policy-runtime/v1",
    workspaceId: workspaceLayoutId,
    editorGroups: emptySnapshot,
  };

  const restoredStore = createEditorGroupsService();
  restoredStore.getState().deserializeModel(emptySnapshot);

  const workspaceService = createWorkspaceService();
  workspaceService.getState().openWorkspace({
    id: workspaceLayoutId,
    absolutePath: `${workspaceRoot}/persist`,
    displayName: "Empty Persist",
  });
  workspaceService.getState().saveLayoutModel(workspaceLayoutId, layout);

  const storedLayout = safeJsonParse(localStorage.getItem(workspaceKey));
  const workspaceRoundTrip = workspaceService.getState().getLayoutModel(workspaceLayoutId);
  const workspaceRestoredStore = createEditorGroupsService();
  const workspaceEditorGroups = asFinalEmptyWorkspaceLayout(workspaceRoundTrip)?.editorGroups ?? null;
  if (workspaceEditorGroups) {
    workspaceRestoredStore.getState().deserializeModel(workspaceEditorGroups);
  }

  localStorage.setItem(corruptKey, "{not-json");
  const corruptWorkspaceService = createWorkspaceService({
    openWorkspaces: [{
      id: corruptWorkspaceId,
      absolutePath: `${workspaceRoot}/corrupt`,
      displayName: "Corrupt Empty Persist",
    }],
    activeWorkspaceId: corruptWorkspaceId,
  });
  const corruptLayout = corruptWorkspaceService.getState().getLayoutModel(corruptWorkspaceId);
  const fallbackStore = createEditorGroupsService();
  localStorage.removeItem(corruptKey);
  localStorage.removeItem(workspaceKey);

  const serializedTabSets = collectSerializedTabSets(emptySnapshot);
  const serializedFinalTabSet = serializedTabSets[0] ?? null;
  const restoredGroups = restoredStore.getState().groups;
  const fallbackGroups = fallbackStore.getState().groups;
  const serviceRoundTripLossless = sameJson(restoredStore.getState().serializeModel(), emptySnapshot);
  const workspaceStorageLossless = sameJson(storedLayout, layout) &&
    sameJson(workspaceRoundTrip, layout) &&
    sameJson(workspaceRestoredStore.getState().serializeModel(), emptySnapshot);
  const serializedFinalTabSetHasNoTabs = serializedTabSets.length === 1 && (serializedFinalTabSet?.children?.length ?? 0) === 0;
  const status = serializedFinalTabSetHasNoTabs &&
    restoredGroups.length === 1 &&
    restoredGroups[0]?.tabs.length === 0 &&
    serviceRoundTripLossless &&
    workspaceStorageLossless &&
    corruptLayout === null &&
    fallbackGroups.length === 1 &&
    fallbackGroups[0]?.tabs.length === 0
    ? "pass"
    : "fail";

  return {
    status,
    serializedTabSetCount: serializedTabSets.length,
    serializedFinalTabSetHasNoTabs,
    restoredGroupCount: restoredGroups.length,
    restoredFinalGroupTabCount: restoredGroups[0]?.tabs.length ?? null,
    serviceRoundTripLossless,
    workspaceStorageLossless,
    corruptLayoutIsNull: corruptLayout === null,
    fallbackGroupCount: fallbackGroups.length,
    fallbackFinalGroupTabCount: fallbackGroups[0]?.tabs.length ?? null,
    reason: status === "pass"
      ? undefined
      : `Expected final empty group to survive service/workspace round-trip and corrupt fallback; restored=${restoredGroups.length}:${restoredGroups[0]?.tabs.length ?? "missing"}, workspaceLossless=${workspaceStorageLossless}, corruptNull=${corruptLayout === null}`,
  };
}

function createThreePaneService(): EditorGroupsServiceStore {
  const leftTab = createGroupTab("tab_left", "src/left.ts");
  const centerTab = createGroupTab("tab_center", "src/center.ts");
  const rightTab = createGroupTab("tab_right", "src/right.ts");

  return createEditorGroupsService({
    groups: [
      { id: "group_left", tabs: [leftTab], activeTabId: leftTab.id },
      { id: "group_center", tabs: [centerTab], activeTabId: centerTab.id },
      { id: "group_right", tabs: [rightTab], activeTabId: rightTab.id },
    ],
    activeGroupId: "group_center",
  });
}

function createGroupTab(id: string, path: string): EditorGroupTab {
  return {
    id,
    title: path.split("/").at(-1) ?? path,
    kind: "file",
    workspaceId,
    resourcePath: path,
  };
}

function panesFromGroups(groups: readonly EditorGroup[]): EditorPaneState[] {
  return groups.map((group) => ({
    id: group.id,
    tabs: group.tabs.map(editorTabFromGroupTab),
    activeTabId: group.activeTabId,
  }));
}

function editorTabFromGroupTab(tab: EditorGroupTab): EditorTab {
  const path = tab.resourcePath ?? tab.title;
  const safeIdentifier = tab.id.replace(/\W+/g, "_");

  return {
    kind: "file",
    id: tab.id,
    workspaceId: tab.workspaceId ?? workspaceId,
    path,
    title: tab.title,
    content: `export const ${safeIdentifier} = true;\n`,
    savedContent: `export const ${safeIdentifier} = true;\n`,
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
}

function collectMountedGroupSnapshots(
  rootElement: HTMLElement,
  service: EditorGroupsServiceStore,
): RuntimeGroupSnapshot[] {
  const scenarioElement = rootElement.querySelector<HTMLElement>('[data-empty-group-policy-scenario="mounted-editor"]');
  const layoutElement = scenarioElement?.querySelector<HTMLElement>(".flexlayout__layout") ?? null;
  if (!scenarioElement || !layoutElement) {
    return [];
  }

  const groupsById = new Map(service.getState().groups.map((group) => [group.id, group] as const));
  const byGroupId = new Map<string, HTMLElement>();
  for (const element of Array.from(scenarioElement.querySelectorAll<HTMLElement>('[data-editor-flexlayout-tab-content="true"][data-editor-group-id]'))) {
    const groupId = element.dataset.editorGroupId;
    const rect = element.getBoundingClientRect();
    if (groupId && rect.width > 0 && rect.height > 0 && !byGroupId.has(groupId)) {
      byGroupId.set(groupId, element);
    }
  }

  return Array.from(byGroupId.entries()).map(([groupId, element]) => {
    const group = groupsById.get(groupId) ?? null;
    const rect = rectSnapshot(resolveGroupRect(element, scenarioElement));
    const layoutRect = layoutElement.getBoundingClientRect();

    return {
      groupId,
      tabCount: group?.tabs.length ?? 0,
      activeTabId: group?.activeTabId ?? null,
      rect,
      nonzero: rect.width > 40 && rect.height > 40,
      contained: rect.left >= layoutRect.left - rectTolerancePx &&
        rect.top >= layoutRect.top - rectTolerancePx &&
        rect.right <= layoutRect.right + rectTolerancePx &&
        rect.bottom <= layoutRect.bottom + rectTolerancePx,
    };
  });
}

function resolveGroupRect(contentElement: HTMLElement, scenarioElement: HTMLElement): DOMRect {
  const contentRect = contentElement.getBoundingClientRect();
  const tabsets = Array.from(scenarioElement.querySelectorAll<HTMLElement>(".flexlayout__tabset_container"));
  const best = tabsets
    .map((element) => ({
      element,
      area: rectIntersectionArea(contentRect, element.getBoundingClientRect()),
    }))
    .sort((left, right) => right.area - left.area)[0] ?? null;

  return best && best.area > 0 ? best.element.getBoundingClientRect() : contentRect;
}

function siblingWeightsForTabSets(
  snapshot: EditorGroupsSerializedModel,
  tabSetIds: readonly EditorGroupId[],
): number[] | null {
  return findSiblingWeightsForTabSets(snapshot.layout, tabSetIds);
}

type SerializedLayoutNode =
  | EditorGroupsSerializedModel["layout"]
  | NonNullable<EditorGroupsSerializedModel["layout"]["children"]>[number];

function findSiblingWeightsForTabSets(
  node: SerializedLayoutNode,
  tabSetIds: readonly EditorGroupId[],
): number[] | null {
  if (node.type !== "row") {
    return null;
  }

  const matchingChildren = (node.children ?? [])
    .filter((child) => child.type === "tabset" && tabSetIds.includes(child.id ?? ""));
  if (matchingChildren.length === tabSetIds.length) {
    return matchingChildren.map((child) => child.weight ?? Number.NaN);
  }

  for (const child of node.children ?? []) {
    if (child.type === "row") {
      const weights = findSiblingWeightsForTabSets(child, tabSetIds);
      if (weights) {
        return weights;
      }
    }
  }

  return null;
}

function collectSerializedTabSets(snapshot: EditorGroupsSerializedModel): Array<{ children?: unknown[]; enableDeleteWhenEmpty?: boolean }> {
  const tabSets: Array<{ children?: unknown[]; enableDeleteWhenEmpty?: boolean }> = [];
  visitSerializedLayout(snapshot.layout, (node) => {
    if (node.type === "tabset") {
      tabSets.push({
        children: Array.isArray(node.children) ? node.children : [],
        enableDeleteWhenEmpty: typeof node.enableDeleteWhenEmpty === "boolean" ? node.enableDeleteWhenEmpty : undefined,
      });
    }
  });
  return tabSets;
}

function visitSerializedLayout(node: SerializedLayoutNode, visit: (node: SerializedLayoutNode) => void): void {
  visit(node);
  if (node.type !== "row") {
    return;
  }

  for (const child of node.children ?? []) {
    visitSerializedLayout(child, visit);
  }
}

function rectSnapshot(rect: DOMRect | DOMRectReadOnly): RectSnapshot {
  return {
    left: roundRectNumber(rect.left),
    top: roundRectNumber(rect.top),
    width: roundRectNumber(rect.width),
    height: roundRectNumber(rect.height),
    right: roundRectNumber(rect.right),
    bottom: roundRectNumber(rect.bottom),
  };
}

function rectSizesMatch(actual: RectSnapshot, expected: RectSnapshot, tolerance: number): boolean {
  return Math.abs(actual.width - expected.width) <= tolerance &&
    Math.abs(actual.height - expected.height) <= tolerance;
}

function rectIntersectionArea(leftRect: DOMRect | DOMRectReadOnly, rightRect: DOMRect | DOMRectReadOnly): number {
  const left = Math.max(leftRect.left, rightRect.left);
  const right = Math.min(leftRect.right, rightRect.right);
  const top = Math.max(leftRect.top, rightRect.top);
  const bottom = Math.min(leftRect.bottom, rightRect.bottom);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function roundRectNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => Math.abs(value - (right[index] ?? Number.NaN)) <= 0.001);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableClone);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableClone(value[key])]),
    );
  }
  return value;
}

function asFinalEmptyWorkspaceLayout(layout: WorkspaceLayoutSnapshot | null): FinalEmptyWorkspaceLayout | null {
  if (!isRecord(layout) || layout.schema !== "editor-empty-group-policy-runtime/v1") {
    return null;
  }
  if (typeof layout.workspaceId !== "string" || !isRecord(layout.editorGroups)) {
    return null;
  }

  return layout as FinalEmptyWorkspaceLayout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonParse(serialized: string | null): unknown {
  if (serialized === null) {
    return null;
  }

  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
}

function prepareDocument(rootElement: HTMLElement): void {
  document.documentElement.style.width = "1000px";
  document.documentElement.style.height = "560px";
  document.body.style.width = "1000px";
  document.body.style.height = "560px";
  document.body.style.margin = "0";
  rootElement.style.width = "1000px";
  rootElement.style.height = "560px";
}

function clearFixtureStorage(): void {
  localStorage.removeItem(getWorkspaceLayoutStorageKey("ws_empty_group_policy_persist" as WorkspaceId));
  localStorage.removeItem(getWorkspaceLayoutStorageKey("ws_empty_group_policy_corrupt" as WorkspaceId));
}

function installConsoleCapture(): void {
  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    const message = args.map(stringifyErrorPart).join(" ");
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
    originalConsoleError(...args);
  };
  console.warn = (...args: unknown[]) => {
    const message = args.map(stringifyErrorPart).join(" ");
    capturedConsoleMessages.push(message);
    if (suspiciousMessagePattern.test(message)) {
      capturedErrors.push(message);
    }
    originalConsoleWarn(...args);
  };
  window.addEventListener("error", (event) => {
    const message = stringifyErrorPart(event.error ?? event.message ?? event);
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const message = stringifyErrorPart(event.reason);
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, errorMessage: () => string): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await animationFrame();
  }
  throw new Error(errorMessage());
}

async function settleFor(ms: number): Promise<void> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    await animationFrame();
  }
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function failedResult(reason: string): EditorEmptyGroupPolicyRuntimeSmokeResult {
  const failedScenario = { status: "fail" as const, reason };
  return {
    ok: false,
    errors: [reason],
    scenarios: {
      closeCenterRelayout: {
        ...failedScenario,
        beforeGroupIds: [],
        afterGroupIds: [],
        centerRemoved: false,
        remainingGroupsNonzero: false,
        remainingGroupsContained: false,
        layoutFillsContainer: false,
        areaCoverageRatio: 0,
        groups: [],
      },
      closeAllFinalEmpty: {
        ...failedScenario,
        groupCount: 0,
        finalGroupId: null,
        finalGroupTabCount: null,
        placeholderVisible: false,
        placeholderRole: null,
        placeholderAriaLabel: null,
        serializedTabSetCount: 0,
        finalTabSetPreserved: false,
      },
      splitEmptyNoop: {
        ...failedScenario,
        returnedGroupId: null,
        modelUnchanged: false,
        groupCount: 0,
        finalGroupTabCount: null,
      },
      splitCommandDuplicate: {
        ...failedScenario,
        splitGroupId: null,
        sourceGroupTabs: [],
        targetGroupTabs: [],
        logicalTabOccurrences: 0,
        logicalPathOccurrences: 0,
        activeGroupId: null,
        sourceRetainedTab: false,
        targetDuplicatedTab: false,
      },
      splitSizingAuto: {
        ...failedScenario,
        firstSplitGroupId: null,
        secondSplitGroupId: null,
        firstSplitWeights: null,
        resizedWeightsBeforeSecondSplit: null,
        secondSplitWeights: null,
        firstSplitEqual: false,
        userResizeObserved: false,
        activeGroupHalvedAfterResize: false,
      },
      finalEmptyPersistence: {
        ...failedScenario,
        serializedTabSetCount: 0,
        serializedFinalTabSetHasNoTabs: false,
        restoredGroupCount: 0,
        restoredFinalGroupTabCount: null,
        serviceRoundTripLossless: false,
        workspaceStorageLossless: false,
        corruptLayoutIsNull: false,
        fallbackGroupCount: 0,
        fallbackFinalGroupTabCount: null,
      },
    },
    reason,
  };
}

function publishResult(result: EditorEmptyGroupPolicyRuntimeSmokeResult): void {
  window.__nexusEditorEmptyGroupPolicyRuntimeSmokeResult = result;
}

function stringifyErrorPart(part: unknown): string {
  if (part instanceof Error) {
    return part.stack ?? part.message;
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
