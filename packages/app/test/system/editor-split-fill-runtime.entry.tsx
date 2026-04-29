import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import { installMonacoEnvironment } from "../../src/renderer/editor/monaco-environment";
import { EditorGroupsPart } from "../../src/renderer/parts/editor-groups/EditorGroupsPart";
import {
  DEFAULT_EDITOR_GROUP_ID,
  createEditorGroupsService,
  type EditorGroup,
  type EditorGroupSplitDirection,
  type EditorGroupTab,
  type EditorGroupsSerializedModel,
  type EditorGroupsServiceStore,
} from "../../src/renderer/services/editor-groups-service";
import { createTerminalService, type TerminalServiceStore } from "../../src/renderer/services/terminal-service";
import type { EditorPaneState, EditorTab } from "../../src/renderer/services/editor-types";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import "@xterm/xterm/css/xterm.css";

type ScenarioId = "horizontal" | "vertical" | "four-pane" | "six-pane";
type FinalEmptyScenarioId = "final-empty";
type ScenarioStatus = "pass" | "fail";

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface GroupFillSnapshot {
  groupId: string;
  tabCount: number;
  activeTabId: string | null;
  rect: RectSnapshot;
  nonzero: boolean;
  contained: boolean;
}

interface SplitFillScenarioResult {
  id: ScenarioId;
  status: ScenarioStatus;
  expectedGroupCount: number;
  actualGroupCount: number;
  layoutRect: RectSnapshot;
  scenarioRect: RectSnapshot;
  groups: GroupFillSnapshot[];
  allGroupsNonzero: boolean;
  allGroupsContained: boolean;
  layoutFillsScenario: boolean;
  areaCoverageRatio: number;
  fillConsistent: boolean;
  axisConsistency: {
    checked: "horizontal" | "vertical" | "grid";
    passed: boolean;
    reason?: string;
  };
  reason?: string;
}

interface FinalEmptyGroupFillResult {
  id: FinalEmptyScenarioId;
  status: ScenarioStatus;
  groupCount: number;
  finalGroupId: string | null;
  finalGroupTabCount: number | null;
  placeholderVisible: boolean;
  layoutFillsScenario: boolean;
  serializedTabSetCount: number;
  finalTabSetPreserved: boolean;
  reason?: string;
}

interface EditorSplitFillRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarios: Record<ScenarioId, SplitFillScenarioResult>;
  finalEmptyGroup: FinalEmptyGroupFillResult;
  reason?: string;
}

declare global {
  interface Window {
    __nexusEditorSplitFillRuntimeSmokeResult?: EditorSplitFillRuntimeSmokeResult;
  }
}

interface RuntimeFixture {
  id: ScenarioId | FinalEmptyScenarioId;
  label: string;
  expectedGroupCount: number;
  width: number;
  height: number;
  service: EditorGroupsServiceStore;
  terminalService: TerminalServiceStore;
}

interface SplitScenarioFixture extends RuntimeFixture {
  id: ScenarioId;
}

interface FinalEmptyFixture extends RuntimeFixture {
  id: FinalEmptyScenarioId;
}

const workspaceId = "ws_split_fill_runtime" as WorkspaceId;
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;
const scenarioDimensions = { width: 860, height: 420 };
const rectTolerancePx = 6;

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
    const fixtures = createScenarioFixtures();
    const finalEmptyFixture = createFinalEmptyFixture();
    createRoot(rootElement).render(
      <StrictMode>
        <SplitFillWorkbench fixtures={fixtures} finalEmptyFixture={finalEmptyFixture} />
      </StrictMode>,
    );

    await waitUntil(
      () => fixtures.every((fixture) => collectScenarioGroupElements(fixture.id).length === fixture.expectedGroupCount),
      10_000,
      () => `Timed out waiting for split fill scenarios; counts=${fixtures.map((fixture) => `${fixture.id}:${collectScenarioGroupElements(fixture.id).length}/${fixture.expectedGroupCount}`).join(",")}`,
    );
    await waitUntil(
      () => collectFinalEmptyGroupResult(finalEmptyFixture).status === "pass",
      10_000,
      () => `Timed out waiting for final empty group placeholder; result=${JSON.stringify(collectFinalEmptyGroupResult(finalEmptyFixture))}`,
    );
    await settleFor(250);

    const scenarioEntries = fixtures.map((fixture) => [fixture.id, collectScenarioResult(fixture)] as const);
    const scenarios = Object.fromEntries(scenarioEntries) as Record<ScenarioId, SplitFillScenarioResult>;
    const finalEmptyGroup = collectFinalEmptyGroupResult(finalEmptyFixture);
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const scenarioErrors = Object.values(scenarios)
      .filter((scenario) => scenario.status !== "pass")
      .map((scenario) => `${scenario.id}: ${scenario.reason ?? "failed"}`);
    const errors = [
      ...fatalErrors,
      ...scenarioErrors,
      ...(finalEmptyGroup.status === "pass" ? [] : [`${finalEmptyGroup.id}: ${finalEmptyGroup.reason ?? "failed"}`]),
    ];
    const ok = errors.length === 0;

    publishResult({
      ok,
      errors,
      scenarios,
      finalEmptyGroup,
      reason: errors[0],
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function SplitFillWorkbench({
  fixtures,
  finalEmptyFixture,
}: {
  fixtures: SplitScenarioFixture[];
  finalEmptyFixture: FinalEmptyFixture;
}): JSX.Element {
  return (
    <div data-split-fill-workbench="true" className="bg-background p-4 text-foreground">
      {fixtures.map((fixture) => (
        <section key={fixture.id} className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">{fixture.label}</h2>
          <ScenarioMount fixture={fixture} />
        </section>
      ))}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">{finalEmptyFixture.label}</h2>
        <ScenarioMount fixture={finalEmptyFixture} />
      </section>
    </div>
  );
}

function ScenarioMount({ fixture }: { fixture: RuntimeFixture }): JSX.Element {
  const groups = useStore(fixture.service, (state) => state.groups);
  const activeGroupId = useStore(fixture.service, (state) => state.activeGroupId);
  const layoutSnapshot = useStore(fixture.service, (state) => state.layoutSnapshot);
  const model = useStore(fixture.service, (state) => state.model);
  const panes = useMemo(() => panesFromGroups(groups), [groups]);

  return (
    <div
      data-split-fill-scenario={fixture.id}
      data-expected-group-count={fixture.expectedGroupCount}
      className="overflow-hidden rounded border border-border bg-background"
      style={{ width: fixture.width, height: fixture.height }}
    >
      <EditorGroupsPart
        activeGroupId={activeGroupId}
        groups={groups}
        editorGroupsService={fixture.service}
        terminalService={fixture.terminalService}
        layoutSnapshot={layoutSnapshot}
        model={model}
        activeWorkspaceId={null}
        activeWorkspaceName={null}
        panes={panes}
        activePaneId={activeGroupId ?? DEFAULT_EDITOR_GROUP_ID}
        onActivatePane={(paneId) => fixture.service.getState().activateGroup(paneId)}
        onSplitRight={() => {}}
        onCloseTab={() => {}}
        onSaveTab={() => {}}
        onChangeContent={() => {}}
      />
    </div>
  );
}

function createScenarioFixtures(): SplitScenarioFixture[] {
  return [
    createScenarioFixture({
      id: "horizontal",
      label: "Horizontal 2-pane right split",
      fileCount: 2,
      splits: [
        { tabIndex: 2, direction: "right", targetGroupId: "horizontal_right" },
      ],
    }),
    createScenarioFixture({
      id: "vertical",
      label: "Vertical 2-pane bottom split",
      fileCount: 2,
      splits: [
        { tabIndex: 2, direction: "bottom", targetGroupId: "vertical_bottom" },
      ],
    }),
    createScenarioFixture({
      id: "four-pane",
      label: "Four-pane mixed split group",
      fileCount: 4,
      splits: [
        { tabIndex: 4, direction: "right", targetGroupId: "four_right" },
        { tabIndex: 3, direction: "bottom", targetGroupId: "four_bottom" },
        { tabIndex: 2, direction: "right", targetGroupId: "four_inner_right" },
      ],
    }),
    createScenarioFixture({
      id: "six-pane",
      label: "Six-pane maximum editor group split",
      fileCount: 6,
      splits: [
        { tabIndex: 6, direction: "right", targetGroupId: "six_right" },
        { tabIndex: 5, direction: "bottom", targetGroupId: "six_bottom" },
        { tabIndex: 4, direction: "right", targetGroupId: "six_inner_right" },
        { tabIndex: 3, direction: "bottom", targetGroupId: "six_inner_bottom" },
        { tabIndex: 2, direction: "right", targetGroupId: "six_last_right" },
      ],
    }),
  ];
}

function createFinalEmptyFixture(): FinalEmptyFixture {
  return {
    id: "final-empty",
    label: "Final empty group remains valid and fills the editor",
    expectedGroupCount: 1,
    width: scenarioDimensions.width,
    height: scenarioDimensions.height,
    service: createEditorGroupsService(),
    terminalService: createTerminalService(),
  };
}

function createScenarioFixture({
  id,
  label,
  fileCount,
  splits,
}: {
  id: ScenarioId;
  label: string;
  fileCount: number;
  splits: { tabIndex: number; direction: EditorGroupSplitDirection; targetGroupId: string }[];
}): SplitScenarioFixture {
  const tabs = Array.from({ length: fileCount }, (_, index) => createGroupTab(id, index + 1));
  const service = createEditorGroupsService({
    groups: [{ id: DEFAULT_EDITOR_GROUP_ID, tabs, activeTabId: tabs.at(-1)?.id ?? null }],
    activeGroupId: DEFAULT_EDITOR_GROUP_ID,
  });

  for (const split of splits) {
    const tab = tabs[split.tabIndex - 1];
    if (!tab) {
      continue;
    }

    service.getState().splitGroup({
      sourceGroupId: DEFAULT_EDITOR_GROUP_ID,
      tabId: tab.id,
      direction: split.direction,
      targetGroupId: split.targetGroupId,
      activate: false,
    });
  }

  return {
    id,
    label,
    expectedGroupCount: splits.length + 1,
    width: scenarioDimensions.width,
    height: scenarioDimensions.height,
    service,
    terminalService: createTerminalService(),
  };
}

function createGroupTab(scenarioId: ScenarioId, index: number): EditorGroupTab {
  const path = `${scenarioId}/file-${index}.ts`;
  return {
    id: `${workspaceId}::${path}`,
    title: `${scenarioId}-${index}.ts`,
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
  return {
    kind: "file",
    id: tab.id,
    workspaceId: tab.workspaceId ?? workspaceId,
    path,
    title: tab.title,
    content: `export const ${tab.id.replace(/\W+/g, "_")} = true;\n`,
    savedContent: `export const ${tab.id.replace(/\W+/g, "_")} = true;\n`,
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

function collectScenarioResult(fixture: SplitScenarioFixture): SplitFillScenarioResult {
  const scenarioElement = scenarioElementFor(fixture.id);
  if (!scenarioElement) {
    return failedScenarioResult(fixture, `Scenario element ${fixture.id} is missing.`);
  }

  const layoutElement = scenarioElement.querySelector<HTMLElement>(".flexlayout__layout");
  if (!layoutElement) {
    return failedScenarioResult(fixture, `Scenario ${fixture.id} has no flexlayout layout element.`);
  }

  const scenarioRect = rectSnapshot(scenarioElement.getBoundingClientRect());
  const layoutRect = rectSnapshot(layoutElement.getBoundingClientRect());
  const groupElements = collectScenarioGroupElements(fixture.id);
  const groups = groupElements.map((element) => groupFillSnapshot(element, scenarioElement, layoutElement));
  const allGroupsNonzero = groups.every((group) => group.nonzero);
  const allGroupsContained = groups.every((group) => group.contained);
  const layoutFillsScenario = rectSizesMatch(layoutRect, scenarioRect, rectTolerancePx);
  const areaCoverageRatio = roundRectNumber(
    groups.reduce((sum, group) => sum + group.rect.width * group.rect.height, 0) /
      Math.max(1, layoutRect.width * layoutRect.height),
  );
  const fillConsistent = layoutFillsScenario && allGroupsNonzero && allGroupsContained && areaCoverageRatio >= 0.9 && areaCoverageRatio <= 1.02;
  const axisConsistency = collectAxisConsistency(fixture.id, groups, layoutRect);
  const actualGroupCount = groups.length;
  const status = actualGroupCount === fixture.expectedGroupCount && fillConsistent && axisConsistency.passed ? "pass" : "fail";

  return {
    id: fixture.id,
    status,
    expectedGroupCount: fixture.expectedGroupCount,
    actualGroupCount,
    layoutRect,
    scenarioRect,
    groups,
    allGroupsNonzero,
    allGroupsContained,
    layoutFillsScenario,
    areaCoverageRatio,
    fillConsistent,
    axisConsistency,
    reason: status === "pass"
      ? undefined
      : `Expected ${fixture.expectedGroupCount} nonzero contained groups with fill ratio 0.9..1.02; actual=${actualGroupCount}, nonzero=${allGroupsNonzero}, contained=${allGroupsContained}, layoutFills=${layoutFillsScenario}, ratio=${areaCoverageRatio}, axis=${axisConsistency.reason ?? axisConsistency.passed}`,
  };
}

function collectFinalEmptyGroupResult(fixture: FinalEmptyFixture): FinalEmptyGroupFillResult {
  const scenarioElement = scenarioElementFor(fixture.id);
  const layoutElement = scenarioElement?.querySelector<HTMLElement>(".flexlayout__layout") ?? null;
  const placeholder = scenarioElement?.querySelector<HTMLElement>('[data-editor-empty-group-placeholder="true"]') ?? null;
  const groups = fixture.service.getState().groups;
  const finalGroup = groups[0] ?? null;
  const serializedTabSets = collectSerializedTabSets(fixture.service.getState().serializeModel());
  const finalTabSet = serializedTabSets[0] ?? null;
  const scenarioRect = scenarioElement ? rectSnapshot(scenarioElement.getBoundingClientRect()) : null;
  const layoutRect = layoutElement ? rectSnapshot(layoutElement.getBoundingClientRect()) : null;
  const layoutFillsScenario = Boolean(layoutRect && scenarioRect && rectSizesMatch(layoutRect, scenarioRect, rectTolerancePx));
  const finalTabSetPreserved = serializedTabSets.length === 1 &&
    (finalTabSet?.children?.length ?? 0) === 0 &&
    finalTabSet?.enableDeleteWhenEmpty === false;
  const status = groups.length === 1 &&
    finalGroup?.tabs.length === 0 &&
    placeholder !== null &&
    layoutFillsScenario &&
    finalTabSetPreserved
    ? "pass"
    : "fail";

  return {
    id: "final-empty",
    status,
    groupCount: groups.length,
    finalGroupId: finalGroup?.id ?? null,
    finalGroupTabCount: finalGroup?.tabs.length ?? null,
    placeholderVisible: placeholder !== null,
    layoutFillsScenario,
    serializedTabSetCount: serializedTabSets.length,
    finalTabSetPreserved,
    reason: status === "pass"
      ? undefined
      : `Expected one final empty group with placeholder and filled layout; groupCount=${groups.length}, tabCount=${finalGroup?.tabs.length ?? "missing"}, placeholder=${placeholder !== null}, layoutFills=${layoutFillsScenario}, tabsets=${serializedTabSets.length}`,
  };
}

function groupFillSnapshot(
  contentElement: HTMLElement,
  scenarioElement: HTMLElement,
  layoutElement: HTMLElement,
): GroupFillSnapshot {
  const groupId = contentElement.dataset.editorGroupId ?? "";
  const groupRect = resolveGroupRect(contentElement, scenarioElement);
  const rect = rectSnapshot(groupRect);
  const layoutRect = layoutElement.getBoundingClientRect();
  const nonzero = rect.width > 40 && rect.height > 40;
  const contained = rect.left >= layoutRect.left - rectTolerancePx &&
    rect.top >= layoutRect.top - rectTolerancePx &&
    rect.right <= layoutRect.right + rectTolerancePx &&
    rect.bottom <= layoutRect.bottom + rectTolerancePx;

  return {
    groupId,
    tabCount: Number(scenarioElement.querySelector<HTMLElement>(`[data-editor-grid-slot][data-editor-group-id="${CSS.escape(groupId)}"]`)?.dataset.editorGroupTabCount ?? "0"),
    activeTabId: scenarioElement.querySelector<HTMLElement>(`[data-editor-grid-slot][data-editor-group-id="${CSS.escape(groupId)}"]`)?.dataset.editorGroupActiveTabId ?? null,
    rect,
    nonzero,
    contained,
  };
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

function collectAxisConsistency(
  scenarioId: ScenarioId,
  groups: readonly GroupFillSnapshot[],
  layoutRect: RectSnapshot,
): SplitFillScenarioResult["axisConsistency"] {
  if (scenarioId === "horizontal") {
    const sameTop = maxDelta(groups.map((group) => group.rect.top)) <= rectTolerancePx;
    const sameHeight = maxDelta(groups.map((group) => group.rect.height)) <= rectTolerancePx;
    const widthSum = groups.reduce((sum, group) => sum + group.rect.width, 0);
    const widthFills = Math.abs(widthSum - layoutRect.width) <= rectTolerancePx * groups.length;
    const passed = sameTop && sameHeight && widthFills;
    return {
      checked: "horizontal",
      passed,
      reason: passed ? undefined : `horizontal sameTop=${sameTop}, sameHeight=${sameHeight}, widthSum=${widthSum}, layoutWidth=${layoutRect.width}`,
    };
  }

  if (scenarioId === "vertical") {
    const sameLeft = maxDelta(groups.map((group) => group.rect.left)) <= rectTolerancePx;
    const sameWidth = maxDelta(groups.map((group) => group.rect.width)) <= rectTolerancePx;
    const heightSum = groups.reduce((sum, group) => sum + group.rect.height, 0);
    const heightFills = Math.abs(heightSum - layoutRect.height) <= rectTolerancePx * groups.length;
    const passed = sameLeft && sameWidth && heightFills;
    return {
      checked: "vertical",
      passed,
      reason: passed ? undefined : `vertical sameLeft=${sameLeft}, sameWidth=${sameWidth}, heightSum=${heightSum}, layoutHeight=${layoutRect.height}`,
    };
  }

  const distinctLefts = new Set(groups.map((group) => Math.round(group.rect.left))).size;
  const distinctTops = new Set(groups.map((group) => Math.round(group.rect.top))).size;
  const passed = distinctLefts >= 2 && distinctTops >= 2;
  return {
    checked: "grid",
    passed,
    reason: passed ? undefined : `grid expected at least two columns and rows; lefts=${distinctLefts}, tops=${distinctTops}`,
  };
}

function collectScenarioGroupElements(scenarioId: ScenarioId | FinalEmptyScenarioId): HTMLElement[] {
  const scenarioElement = scenarioElementFor(scenarioId);
  if (!scenarioElement) {
    return [];
  }

  const byGroupId = new Map<string, HTMLElement>();
  for (const element of Array.from(scenarioElement.querySelectorAll<HTMLElement>('[data-editor-flexlayout-tab-content="true"][data-editor-group-id]'))) {
    const groupId = element.dataset.editorGroupId;
    const rect = element.getBoundingClientRect();
    if (groupId && rect.width > 0 && rect.height > 0 && !byGroupId.has(groupId)) {
      byGroupId.set(groupId, element);
    }
  }
  return Array.from(byGroupId.values());
}

function scenarioElementFor(scenarioId: ScenarioId | FinalEmptyScenarioId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-split-fill-scenario="${scenarioId}"]`);
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

type SerializedLayoutNode =
  | EditorGroupsSerializedModel["layout"]
  | NonNullable<EditorGroupsSerializedModel["layout"]["children"]>[number];

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

function maxDelta(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.max(...values) - Math.min(...values);
}

function roundRectNumber(value: number): number {
  return Math.round(value * 100) / 100;
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

function prepareDocument(rootElement: HTMLElement): void {
  document.documentElement.style.width = "1000px";
  document.documentElement.style.height = "2500px";
  document.body.style.width = "1000px";
  document.body.style.height = "2500px";
  document.body.style.margin = "0";
  rootElement.style.width = "1000px";
  rootElement.style.height = "2500px";
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

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function settleFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function failedScenarioResult(fixture: SplitScenarioFixture, reason: string): SplitFillScenarioResult {
  return {
    id: fixture.id,
    status: "fail",
    expectedGroupCount: fixture.expectedGroupCount,
    actualGroupCount: 0,
    layoutRect: emptyRect(),
    scenarioRect: emptyRect(),
    groups: [],
    allGroupsNonzero: false,
    allGroupsContained: false,
    layoutFillsScenario: false,
    areaCoverageRatio: 0,
    fillConsistent: false,
    axisConsistency: {
      checked: fixture.id === "horizontal" ? "horizontal" : fixture.id === "vertical" ? "vertical" : "grid",
      passed: false,
      reason,
    },
    reason,
  };
}

function failedFinalEmptyGroupResult(reason: string): FinalEmptyGroupFillResult {
  return {
    id: "final-empty",
    status: "fail",
    groupCount: 0,
    finalGroupId: null,
    finalGroupTabCount: null,
    placeholderVisible: false,
    layoutFillsScenario: false,
    serializedTabSetCount: 0,
    finalTabSetPreserved: false,
    reason,
  };
}

function failedResult(reason: string): EditorSplitFillRuntimeSmokeResult {
  const fixtures = createScenarioFixtures();
  const scenarios = Object.fromEntries(
    fixtures.map((fixture) => [fixture.id, failedScenarioResult(fixture, reason)]),
  ) as Record<ScenarioId, SplitFillScenarioResult>;
  return {
    ok: false,
    errors: [reason],
    scenarios,
    finalEmptyGroup: failedFinalEmptyGroupResult(reason),
    reason,
  };
}

function emptyRect(): RectSnapshot {
  return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
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

function publishResult(result: EditorSplitFillRuntimeSmokeResult): void {
  window.__nexusEditorSplitFillRuntimeSmokeResult = result;
}
