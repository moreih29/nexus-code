import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceFileTreeNode } from "../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace, WorkspaceSidebarState } from "../../../shared/src/contracts/workspace/workspace-shell";
import { installMonacoEnvironment } from "../../src/renderer/editor/monaco-environment";
import { keyboardRegistryStore } from "../../src/renderer/stores/keyboard-registry";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import "@xterm/xterm/css/xterm.css";

type Disposable = { dispose(): void };
type GenericListener = (event: unknown) => void;
type EditorListener = (event: unknown) => void;
type SpatialDirection = "left" | "right" | "up" | "down";
type RuntimeTopology = "row" | "column" | "mixed" | "unknown";

interface RuntimeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RuntimeGroup {
  id: string;
  active: boolean;
  tabTitles: string[];
  rect: RuntimeRect;
}

interface SixGroupSpatialRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  productionPath: {
    appShellMounted: boolean;
    editorGroupsPartMounted: boolean;
    editorGridProvider: string | null;
    flexlayoutProviderMatched: boolean;
  };
  sixGroupFixture: {
    baseFiles: string[];
    openedTabTitles: string[];
    populatedGroupCount: number;
    topology: RuntimeTopology;
    groups: RuntimeGroup[];
  };
  keyboardContract: {
    expectedBindings: Record<SpatialDirection, string>;
    expectedCommands: Record<SpatialDirection, string>;
    bindingByDirection: Record<SpatialDirection, string | null>;
    commandPresentByDirection: Record<SpatialDirection, boolean>;
    missingBindings: string[];
    missingCommands: string[];
  };
  spatialMovement: {
    directionResults: DirectionMovementResult[];
    edgeStopResults: EdgeStopResult[];
    deterministicContracts: DeterministicContractSummary[];
  };
  visualSanity: VisualSanityResult;
  t14Dependency: {
    missingSpatialKeyboardImplementation: boolean;
    missingBindings: string[];
    missingCommands: string[];
    movementFailures: string[];
  };
  reason?: string;
}

interface DirectionMovementResult {
  direction: SpatialDirection;
  probeFile: string;
  startGroupId: string | null;
  expectedNeighborGroupId: string | null;
  actualGroupId: string | null;
  activeGroupIdAfter: string | null;
  passed: boolean;
  reason?: string;
}

interface EdgeStopResult {
  direction: SpatialDirection;
  probeFile: string;
  edgeGroupId: string | null;
  actualGroupId: string | null;
  activeGroupIdAfter: string | null;
  passed: boolean;
  reason?: string;
}

interface VisualSanityResult {
  threshold: number;
  activeGroupId: string | null;
  inactiveGroupId: string | null;
  activeBackground: string | null;
  inactiveBackground: string | null;
  activeLuminance: number | null;
  inactiveLuminance: number | null;
  delta: number | null;
  passed: boolean;
  reason?: string;
}

interface DeterministicContractSummary {
  topology: "row" | "column" | "mixed";
  directionCount: number;
  edgeStopCount: number;
}

interface ParsedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

declare global {
  interface Window {
    __nexusSixGroupSpatialRuntimeSmokeResult?: SixGroupSpatialRuntimeSmokeResult;
  }
}

const directions: readonly SpatialDirection[] = ["left", "right", "up", "down"];
const minLuminanceDelta = 0.05;
const workspaceId = "ws_six_group_spatial_runtime" as WorkspaceId;
const workspaceRoot = "/tmp/nexus-six-group-spatial-runtime";
const activeWorkspace: OpenSessionWorkspace = {
  id: workspaceId,
  displayName: "Six Group Spatial Runtime",
  absolutePath: workspaceRoot,
};
const sidebarState: WorkspaceSidebarState = {
  openWorkspaces: [activeWorkspace],
  activeWorkspaceId: workspaceId,
};
const baseFiles = ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts", "epsilon.ts", "zeta.ts"];
const movementProbeFiles: Record<SpatialDirection, string> = {
  left: "move-left-probe.ts",
  right: "move-right-probe.ts",
  up: "move-up-probe.ts",
  down: "move-down-probe.ts",
};
const edgeProbeFiles: Record<SpatialDirection, string> = {
  left: "edge-left-probe.ts",
  right: "edge-right-probe.ts",
  up: "edge-up-probe.ts",
  down: "edge-down-probe.ts",
};
const allFixtureFiles = [...baseFiles, ...Object.values(movementProbeFiles), ...Object.values(edgeProbeFiles)];
const fixtureNodes: WorkspaceFileTreeNode[] = allFixtureFiles.map((path) => ({
  name: path,
  path,
  kind: "file",
}));
const expectedBindings: Record<SpatialDirection, string> = {
  left: "Cmd+Alt+ArrowLeft",
  right: "Cmd+Alt+ArrowRight",
  up: "Cmd+Alt+ArrowUp",
  down: "Cmd+Alt+ArrowDown",
};
const expectedCommands: Record<SpatialDirection, string> = {
  left: "editor.moveActiveTabLeft",
  right: "editor.moveActiveTabRight",
  up: "editor.moveActiveTabUp",
  down: "editor.moveActiveTabDown",
};
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];
const workspaceListeners = new Set<(state: WorkspaceSidebarState) => void>();
const editorListeners = new Set<EditorListener>();
const harnessListeners = new Set<GenericListener>();
const searchListeners = new Set<GenericListener>();
const gitListeners = new Set<GenericListener>();
const terminalListeners = new Set<GenericListener>();
const claudeConsentListeners = new Set<GenericListener>();
const counters = {
  treeReadCount: 0,
  terminalOpenCount: 0,
  gitInvokeActions: [] as string[],
};
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;

installMonacoEnvironment();
installConsoleCapture();
installPreloadMocks();
void runSmoke();

async function runSmoke(): Promise<void> {
  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);

    const { default: App } = await import("../../src/renderer/App");
    createRoot(rootElement).render(createElement(StrictMode, null, createElement(App)));

    await waitForSelector('[data-component="activity-bar"]', 10_000);
    await waitForSelector('[data-component="side-bar"][data-active-content-id="explorer"]', 10_000);
    await waitForSelector('[data-component="editor-groups-part"]', 10_000);
    await waitForSelector(`[data-action="file-tree-open-file"][data-path="${baseFiles[0]}"]`, 10_000);

    await buildSixGroupFixture();
    const productionPath = collectProductionPathEvidence();
    const keyboardContract = collectKeyboardContract();
    const sixGroupFixture = collectSixGroupFixture();
    const visualSanity = collectVisualSanity();
    const directionResults = await exerciseSpatialDirections();
    const edgeStopResults = await exerciseEdgeStops();
    const deterministicContracts = deterministicContractSummaries();
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const movementFailures = [
      ...directionResults.filter((entry) => !entry.passed).map(formatMovementFailure),
      ...edgeStopResults.filter((entry) => !entry.passed).map(formatEdgeFailure),
    ];
    const missingSpatialKeyboardImplementation =
      keyboardContract.missingBindings.length > 0 ||
      keyboardContract.missingCommands.length > 0 ||
      movementFailures.length > 0;
    const errors = [
      ...fatalErrors,
      ...keyboardContract.missingBindings.map((binding) => `Missing spatial keyboard binding: ${binding}`),
      ...keyboardContract.missingCommands.map((command) => `Missing spatial keyboard command: ${command}`),
      ...movementFailures,
      ...(visualSanity.passed ? [] : [visualSanity.reason ?? "Visual sanity assertion failed."]),
    ];
    const ok =
      errors.length === 0 &&
      productionPath.appShellMounted &&
      productionPath.editorGroupsPartMounted &&
      productionPath.editorGridProvider === "flexlayout-model" &&
      productionPath.flexlayoutProviderMatched &&
      sixGroupFixture.populatedGroupCount === 6 &&
      directions.every((direction) => keyboardContract.bindingByDirection[direction] === expectedCommands[direction]) &&
      directions.every((direction) => keyboardContract.commandPresentByDirection[direction]) &&
      directionResults.every((entry) => entry.passed) &&
      edgeStopResults.every((entry) => entry.passed) &&
      visualSanity.passed;

    publishResult({
      ok,
      errors,
      productionPath,
      sixGroupFixture,
      keyboardContract,
      spatialMovement: {
        directionResults,
        edgeStopResults,
        deterministicContracts,
      },
      visualSanity,
      t14Dependency: {
        missingSpatialKeyboardImplementation,
        missingBindings: keyboardContract.missingBindings,
        missingCommands: keyboardContract.missingCommands,
        movementFailures,
      },
      reason:
        errors[0] ??
        (!productionPath.appShellMounted ? "Production AppShell chrome did not mount." : undefined) ??
        (!productionPath.editorGroupsPartMounted ? "Production EditorGroupsPart did not mount." : undefined) ??
        (productionPath.editorGridProvider !== "flexlayout-model"
          ? `Expected production EditorGroupsPart data-editor-grid-provider=flexlayout-model, saw ${productionPath.editorGridProvider ?? "<missing>"}.`
          : undefined) ??
        (sixGroupFixture.populatedGroupCount !== 6
          ? `Expected six populated editor groups, saw ${sixGroupFixture.populatedGroupCount}.`
          : undefined),
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

async function buildSixGroupFixture(): Promise<void> {
  for (const filePath of baseFiles) {
    await openFileFromTree(filePath);
  }

  await splitActiveGroupDown();
  const topGroupId = groupIdContainingTitle("epsilon.ts");
  const bottomGroupId = groupIdContainingTitle("zeta.ts");

  if (!topGroupId || !bottomGroupId || topGroupId === bottomGroupId) {
    throw new Error(
      `Failed to seed vertical editor groups for six-group fixture; top=${topGroupId ?? "<missing>"} bottom=${bottomGroupId ?? "<missing>"} groups=${JSON.stringify(collectGroups())}`,
    );
  }

  await moveFixtureTabSpatially("epsilon.ts", topGroupId, "down", bottomGroupId);
  await moveFixtureTabSpatially("delta.ts", topGroupId, "down", bottomGroupId);

  await splitGroupRight(topGroupId, 3);
  await splitGroupRight(topGroupId, 4);
  await splitGroupRight(bottomGroupId, 5);
  await splitGroupRight(bottomGroupId, 6);

  await waitUntil(
    () => collectGroups().length === baseFiles.length && classifyTopology(collectGroups()) === "mixed",
    5_000,
    () => `Expected six populated mixed-layout groups after split setup; groups=${JSON.stringify(collectGroups())}`,
  );
}

async function splitActiveGroupDown(): Promise<void> {
  await keyboardRegistryStore.getState().executeCommand("editor.splitDown");
  await waitUntil(
    () => collectGroups().length >= 2,
    5_000,
    () => `Timed out creating a vertical editor split; groups=${JSON.stringify(collectGroups())}`,
  );
  await settleFor(100);
}

async function splitGroupRight(groupId: string, expectedGroupCount: number): Promise<void> {
  await activateGroup(groupId);
  dispatchCommandShortcut("\\");
  await waitUntil(
    () => collectGroups().length >= expectedGroupCount,
    5_000,
    () => `Timed out creating editor group ${expectedGroupCount}; groups=${JSON.stringify(collectGroups())}`,
  );
  await settleFor(100);
}

async function moveFixtureTabSpatially(
  filePath: string,
  sourceGroupId: string,
  direction: SpatialDirection,
  expectedTargetGroupId: string,
): Promise<void> {
  await activateEditorTabInGroup(sourceGroupId, filePath);
  dispatchSpatialShortcut(direction);
  await waitUntil(
    () => groupIdContainingTitle(filePath) === expectedTargetGroupId && activeGroupId() === expectedTargetGroupId,
    5_000,
    () => `Timed out moving setup tab ${filePath} ${direction}; expected=${expectedTargetGroupId} actual=${groupIdContainingTitle(filePath) ?? "<missing>"} active=${activeGroupId() ?? "<none>"}`,
  );
  await settleFor(100);
}

async function exerciseSpatialDirections(): Promise<DirectionMovementResult[]> {
  const results: DirectionMovementResult[] = [];

  for (const direction of directions) {
    const groupsBefore = collectGroups();
    const pair = findMovementPair(groupsBefore, direction);
    const probeFile = movementProbeFiles[direction];

    if (!pair) {
      results.push({
        direction,
        probeFile,
        startGroupId: null,
        expectedNeighborGroupId: null,
        actualGroupId: null,
        activeGroupIdAfter: activeGroupId(),
        passed: false,
        reason: `No ${direction} spatial neighbor was available in the current six-group ${classifyTopology(groupsBefore)} layout. The T9 contract requires a fixture geometry that can verify all four directions; T14 must provide spatial neighbor behavior for two-dimensional row/column/mixed trees.`,
      });
      continue;
    }

    await openProbeInGroup(pair.source.id, probeFile);
    dispatchSpatialShortcut(direction);
    await settleFor(250);

    const actualGroupId = groupIdContainingTitle(probeFile);
    const activeAfter = activeGroupId();
    const passed = actualGroupId === pair.neighbor.id && activeAfter === pair.neighbor.id;
    results.push({
      direction,
      probeFile,
      startGroupId: pair.source.id,
      expectedNeighborGroupId: pair.neighbor.id,
      actualGroupId,
      activeGroupIdAfter: activeAfter,
      passed,
      reason: passed
        ? undefined
        : `Cmd+Alt+${arrowKeyForDirection(direction)} should move ${probeFile} from ${pair.source.id} to spatial ${direction} neighbor ${pair.neighbor.id}; actual group=${actualGroupId ?? "<missing>"}, active=${activeAfter ?? "<none>"}.`,
    });
  }

  return results;
}

async function exerciseEdgeStops(): Promise<EdgeStopResult[]> {
  const results: EdgeStopResult[] = [];

  for (const direction of directions) {
    const groupsBefore = collectGroups();
    const edgeGroup = findEdgeGroup(groupsBefore, direction);
    const probeFile = edgeProbeFiles[direction];

    if (!edgeGroup) {
      results.push({
        direction,
        probeFile,
        edgeGroupId: null,
        actualGroupId: null,
        activeGroupIdAfter: activeGroupId(),
        passed: false,
        reason: `No edge group found for ${direction}; cannot verify no-wrap stop behavior.`,
      });
      continue;
    }

    const neighbor = findSpatialNeighbor(groupsBefore, edgeGroup, direction);
    await openProbeInGroup(edgeGroup.id, probeFile);
    dispatchSpatialShortcut(direction);
    await settleFor(250);

    const actualGroupId = groupIdContainingTitle(probeFile);
    const activeAfter = activeGroupId();
    const passed = neighbor === null && actualGroupId === edgeGroup.id && activeAfter === edgeGroup.id;
    results.push({
      direction,
      probeFile,
      edgeGroupId: edgeGroup.id,
      actualGroupId,
      activeGroupIdAfter: activeAfter,
      passed,
      reason: passed
        ? undefined
        : neighbor
          ? `Selected ${edgeGroup.id} as ${direction} edge, but computed neighbor ${neighbor.id}; edge selection is invalid.`
          : `Cmd+Alt+${arrowKeyForDirection(direction)} should stop at ${direction} edge ${edgeGroup.id}; ${probeFile} actual group=${actualGroupId ?? "<missing>"}, active=${activeAfter ?? "<none>"}.`,
    });
  }

  return results;
}

async function openProbeInGroup(groupId: string, filePath: string): Promise<void> {
  await activateGroup(groupId);
  await openFileFromTree(filePath);
  await waitUntil(
    () => groupIdContainingTitle(filePath) === groupId && activeGroupId() === groupId,
    5_000,
    () => `Timed out opening probe ${filePath} into ${groupId}; actual=${groupIdContainingTitle(filePath) ?? "<missing>"}, active=${activeGroupId() ?? "<none>"}`,
  );
}

async function openFileFromTree(filePath: string): Promise<void> {
  const button = await waitForSelector(`[data-action="file-tree-open-file"][data-path="${CSS.escape(filePath)}"]`, 10_000);
  button.click();
  await waitUntil(
    () => visibleEditorTabTitles().includes(filePath),
    10_000,
    () => `Timed out opening ${filePath}; visible tabs=${visibleEditorTabTitles().join(",")}`,
  );
}

async function activateGroup(groupId: string): Promise<void> {
  const pane = editorPaneByGroupId(groupId);
  if (!pane) {
    throw new Error(`Cannot activate missing editor group ${groupId}.`);
  }

  pane.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
  pane.click();
  const tabButton = pane.querySelector<HTMLElement>('[data-action="editor-activate-tab"]');
  tabButton?.click();
  await waitUntil(
    () => activeGroupId() === groupId,
    5_000,
    () => `Timed out activating group ${groupId}; active=${activeGroupId() ?? "<none>"}`,
  );
}

async function activateEditorTabInGroup(groupId: string, title: string): Promise<void> {
  await activateGroup(groupId);
  const pane = editorPaneByGroupId(groupId);
  const tabButton = pane
    ? Array.from(pane.querySelectorAll<HTMLElement>('[data-action="editor-activate-tab"]'))
        .find((button) => button.textContent?.includes(title) === true) ?? null
    : null;

  if (!tabButton) {
    throw new Error(`Cannot activate missing editor tab ${title} in group ${groupId}.`);
  }

  tabButton.click();
  await waitUntil(
    () => groupIdContainingTitle(title) === groupId && activeGroupId() === groupId,
    5_000,
    () => `Timed out activating tab ${title} in ${groupId}; actual=${groupIdContainingTitle(title) ?? "<missing>"} active=${activeGroupId() ?? "<none>"}`,
  );
}

function collectProductionPathEvidence(): SixGroupSpatialRuntimeSmokeResult["productionPath"] {
  const editorGroupsPart = document.querySelector<HTMLElement>('[data-component="editor-groups-part"]');
  const editorGridProvider = editorGroupsPart?.dataset.editorGridProvider ?? null;

  return {
    appShellMounted:
      document.querySelector('[data-component="activity-bar"]') !== null &&
      document.querySelector('[data-component="side-bar"]') !== null &&
      document.querySelector('[data-component="bottom-panel"]') !== null,
    editorGroupsPartMounted: editorGroupsPart !== null,
    editorGridProvider,
    flexlayoutProviderMatched: document.querySelector('[data-editor-grid-provider="flexlayout-model"]') !== null,
  };
}

function collectKeyboardContract(): SixGroupSpatialRuntimeSmokeResult["keyboardContract"] {
  const registry = keyboardRegistryStore.getState();
  const bindingByDirection = Object.fromEntries(
    directions.map((direction) => [direction, registry.bindings[expectedBindings[direction]] ?? null]),
  ) as Record<SpatialDirection, string | null>;
  const commandPresentByDirection = Object.fromEntries(
    directions.map((direction) => [direction, registry.commands[expectedCommands[direction]] !== undefined]),
  ) as Record<SpatialDirection, boolean>;

  return {
    expectedBindings,
    expectedCommands,
    bindingByDirection,
    commandPresentByDirection,
    missingBindings: directions
      .filter((direction) => bindingByDirection[direction] !== expectedCommands[direction])
      .map((direction) => expectedBindings[direction]),
    missingCommands: directions
      .filter((direction) => !commandPresentByDirection[direction])
      .map((direction) => expectedCommands[direction]),
  };
}

function collectSixGroupFixture(): SixGroupSpatialRuntimeSmokeResult["sixGroupFixture"] {
  const groups = collectGroups();

  return {
    baseFiles: [...baseFiles],
    openedTabTitles: visibleEditorTabTitles(),
    populatedGroupCount: groups.length,
    topology: classifyTopology(groups),
    groups,
  };
}

function collectGroups(): RuntimeGroup[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-component="editor-pane"][data-editor-pane-id]'))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.dataset.editorPaneId ?? "",
        active: element.dataset.active === "true",
        tabTitles: Array.from(element.querySelectorAll<HTMLElement>("[data-editor-tab-title-active]"))
          .map((tabTitle) => tabTitle.textContent?.trim() ?? "")
          .filter(Boolean),
        rect: {
          x: roundRectValue(rect.x),
          y: roundRectValue(rect.y),
          width: roundRectValue(rect.width),
          height: roundRectValue(rect.height),
        },
      };
    })
    .filter((group) => group.id.length > 0 && group.rect.width > 0 && group.rect.height > 0 && group.tabTitles.length > 0)
    .sort((left, right) => (left.rect.y - right.rect.y) || (left.rect.x - right.rect.x) || left.id.localeCompare(right.id));
}

function collectVisualSanity(): VisualSanityResult {
  const groups = collectGroups();
  const active = groups.find((group) => group.active) ?? null;
  const inactive = groups.find((group) => !group.active) ?? null;
  const activeHeader = active ? editorPaneByGroupId(active.id)?.querySelector<HTMLElement>("[data-editor-pane-header]") ?? null : null;
  const inactiveHeader = inactive ? editorPaneByGroupId(inactive.id)?.querySelector<HTMLElement>("[data-editor-pane-header]") ?? null : null;
  const activeBackground = activeHeader ? getComputedStyle(activeHeader).backgroundColor : null;
  const inactiveBackground = inactiveHeader ? getComputedStyle(inactiveHeader).backgroundColor : null;
  const canvas = document.createElement("canvas");
  const activeColor = activeBackground ? normalizeCssColor(activeBackground, canvas) : null;
  const inactiveColor = inactiveBackground ? normalizeCssColor(inactiveBackground, canvas) : null;
  const pageBackground = normalizeCssColor(getComputedStyle(document.body).backgroundColor, canvas) ?? { r: 0, g: 0, b: 0, a: 1 };
  const activeLuminance = activeColor ? relativeLuminance(compositeOver(activeColor, pageBackground)) : null;
  const inactiveLuminance = inactiveColor ? relativeLuminance(compositeOver(inactiveColor, pageBackground)) : null;
  const delta = activeLuminance !== null && inactiveLuminance !== null
    ? Math.abs(activeLuminance - inactiveLuminance)
    : null;
  const passed = delta !== null && delta >= minLuminanceDelta;

  return {
    threshold: minLuminanceDelta,
    activeGroupId: active?.id ?? null,
    inactiveGroupId: inactive?.id ?? null,
    activeBackground,
    inactiveBackground,
    activeLuminance,
    inactiveLuminance,
    delta,
    passed,
    reason: passed
      ? undefined
      : `Active/inactive group header dark-mode luminance delta ${delta ?? "<unmeasured>"} is below threshold ${minLuminanceDelta}; active=${activeBackground ?? "<missing>"}, inactive=${inactiveBackground ?? "<missing>"}.`,
  };
}

function findMovementPair(
  groups: RuntimeGroup[],
  direction: SpatialDirection,
): { source: RuntimeGroup; neighbor: RuntimeGroup } | null {
  for (const source of preferInteriorGroups(groups, direction)) {
    const neighbor = findSpatialNeighbor(groups, source, direction);
    if (neighbor) {
      return { source, neighbor };
    }
  }

  return null;
}

function preferInteriorGroups(groups: RuntimeGroup[], direction: SpatialDirection): RuntimeGroup[] {
  const sorted = [...groups].sort((left, right) => {
    if (direction === "left") {
      return right.rect.x - left.rect.x;
    }
    if (direction === "right") {
      return left.rect.x - right.rect.x;
    }
    if (direction === "up") {
      return right.rect.y - left.rect.y;
    }
    return left.rect.y - right.rect.y;
  });

  return sorted;
}

function findEdgeGroup(groups: RuntimeGroup[], direction: SpatialDirection): RuntimeGroup | null {
  if (groups.length === 0) {
    return null;
  }

  const sorted = [...groups].sort((left, right) => {
    if (direction === "left") {
      return left.rect.x - right.rect.x || left.rect.y - right.rect.y;
    }
    if (direction === "right") {
      return right.rect.x - left.rect.x || left.rect.y - right.rect.y;
    }
    if (direction === "up") {
      return left.rect.y - right.rect.y || left.rect.x - right.rect.x;
    }
    return right.rect.y - left.rect.y || left.rect.x - right.rect.x;
  });

  return sorted[0] ?? null;
}

function findSpatialNeighbor(
  groups: RuntimeGroup[],
  source: RuntimeGroup,
  direction: SpatialDirection,
): RuntimeGroup | null {
  const sourceCenter = centerOf(source.rect);
  const candidates = groups
    .filter((candidate) => candidate.id !== source.id)
    .map((candidate) => {
      const candidateCenter = centerOf(candidate.rect);
      const deltaX = candidateCenter.x - sourceCenter.x;
      const deltaY = candidateCenter.y - sourceCenter.y;
      const primaryDistance =
        direction === "left" ? -deltaX :
        direction === "right" ? deltaX :
        direction === "up" ? -deltaY :
        deltaY;
      const secondaryDistance = direction === "left" || direction === "right"
        ? Math.abs(deltaY)
        : Math.abs(deltaX);
      const overlaps = direction === "left" || direction === "right"
        ? rangesOverlap(source.rect.y, source.rect.y + source.rect.height, candidate.rect.y, candidate.rect.y + candidate.rect.height)
        : rangesOverlap(source.rect.x, source.rect.x + source.rect.width, candidate.rect.x, candidate.rect.x + candidate.rect.width);

      return {
        candidate,
        primaryDistance,
        secondaryDistance,
        overlapPenalty: overlaps ? 0 : 1_000_000,
      };
    })
    .filter((entry) => entry.primaryDistance > 8)
    .sort((left, right) =>
      left.primaryDistance - right.primaryDistance ||
      left.overlapPenalty - right.overlapPenalty ||
      left.secondaryDistance - right.secondaryDistance ||
      left.candidate.id.localeCompare(right.candidate.id)
    );

  return candidates[0]?.candidate ?? null;
}

function centerOf(rect: RuntimeRect): { x: number; y: number } {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.max(startA, startB) <= Math.min(endA, endB);
}

function classifyTopology(groups: RuntimeGroup[]): RuntimeTopology {
  if (groups.length === 0) {
    return "unknown";
  }

  const rowCount = clusterCount(groups.map((group) => centerOf(group.rect).y));
  const columnCount = clusterCount(groups.map((group) => centerOf(group.rect).x));

  if (rowCount === 1 && columnCount > 1) {
    return "row";
  }
  if (columnCount === 1 && rowCount > 1) {
    return "column";
  }
  if (rowCount > 1 && columnCount > 1) {
    return "mixed";
  }
  return "unknown";
}

function clusterCount(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const clusters: number[] = [];

  for (const value of sorted) {
    const previous = clusters.at(-1);
    if (previous === undefined || Math.abs(value - previous) > 12) {
      clusters.push(value);
    }
  }

  return clusters.length;
}

function deterministicContractSummaries(): DeterministicContractSummary[] {
  return [
    { topology: "row", directionCount: directions.length, edgeStopCount: directions.length },
    { topology: "column", directionCount: directions.length, edgeStopCount: directions.length },
    { topology: "mixed", directionCount: directions.length, edgeStopCount: directions.length },
  ];
}

function visibleEditorTabTitles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-editor-tab-title-active]"))
    .filter((element) => element.offsetParent !== null)
    .map((element) => element.textContent?.trim() ?? "")
    .filter(Boolean)
    .sort();
}

function groupIdContainingTitle(title: string): string | null {
  return collectGroups().find((group) => group.tabTitles.includes(title))?.id ?? null;
}

function activeGroupId(): string | null {
  return collectGroups().find((group) => group.active)?.id ?? null;
}

function editorPaneByGroupId(groupId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-component="editor-pane"][data-editor-pane-id="${CSS.escape(groupId)}"]`);
}

function dispatchSpatialShortcut(direction: SpatialDirection): void {
  dispatchCommandShortcut(arrowKeyForDirection(direction), { altKey: true });
}

function dispatchCommandShortcut(key: string, modifiers: { altKey?: boolean } = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    code: key === "\\" ? "Backslash" : key,
    metaKey: true,
    altKey: modifiers.altKey === true,
    bubbles: true,
    cancelable: true,
  }));
}

function arrowKeyForDirection(direction: SpatialDirection): string {
  switch (direction) {
    case "left":
      return "ArrowLeft";
    case "right":
      return "ArrowRight";
    case "up":
      return "ArrowUp";
    case "down":
      return "ArrowDown";
  }
}

function installPreloadMocks(): void {
  Object.assign(window, {
    nexusWorkspace: {
      async openFolder() {
        return cloneSidebarState();
      },
      async activateWorkspace() {
        return cloneSidebarState();
      },
      async closeWorkspace() {
        return cloneSidebarState();
      },
      async restoreSession() {
        return cloneSidebarState();
      },
      async getSidebarState() {
        return cloneSidebarState();
      },
      onSidebarStateChanged(listener: (nextState: WorkspaceSidebarState) => void): Disposable {
        workspaceListeners.add(listener);
        return disposable(() => workspaceListeners.delete(listener));
      },
    },
    nexusHarness: {
      onObserverEvent(listener: GenericListener): Disposable {
        harnessListeners.add(listener);
        return disposable(() => harnessListeners.delete(listener));
      },
    },
    nexusClaudeSettings: {
      onConsentRequest(listener: GenericListener): Disposable {
        claudeConsentListeners.add(listener);
        return disposable(() => claudeConsentListeners.delete(listener));
      },
      async respondConsentRequest() {},
    },
    nexusWorkspaceDiff: {
      async readWorkspaceDiff() {
        return {
          type: "workspace/diff/read/result",
          workspaceId,
          files: [],
          generatedAt: new Date(0).toISOString(),
        };
      },
    },
    nexusClaudeSession: {
      async readTranscript() {
        return {
          type: "claude/session/transcript/read/result",
          entries: [],
          readAt: new Date(0).toISOString(),
        };
      },
    },
    nexusEditor: {
      async invoke(request: { type: string; [key: string]: unknown }) {
        return handleEditorInvoke(request);
      },
      onEvent(listener: EditorListener): Disposable {
        editorListeners.add(listener);
        return disposable(() => editorListeners.delete(listener));
      },
    },
    nexusSearch: {
      async startSearch(command: { requestId?: string; workspaceId?: WorkspaceId }) {
        return {
          type: "search/lifecycle",
          action: "failed",
          requestId: command.requestId ?? "six-group-spatial-search-request",
          workspaceId: command.workspaceId ?? workspaceId,
          message: "Search is disabled in six group spatial smoke.",
          failedAt: new Date(0).toISOString(),
        };
      },
      async cancelSearch() {},
      onEvent(listener: GenericListener): Disposable {
        searchListeners.add(listener);
        return disposable(() => searchListeners.delete(listener));
      },
    },
    nexusGit: {
      async invoke(request: { action: string; requestId?: string; workspaceId?: WorkspaceId }) {
        counters.gitInvokeActions.push(request.action);
        return {
          type: "git/lifecycle",
          action: "failed",
          requestId: request.requestId ?? `six-group-spatial-${request.action}`,
          workspaceId: request.workspaceId ?? workspaceId,
          message: "Git is disabled in six group spatial smoke.",
          failedAt: new Date(0).toISOString(),
        };
      },
      onEvent(listener: GenericListener): Disposable {
        gitListeners.add(listener);
        return disposable(() => gitListeners.delete(listener));
      },
    },
    nexusFileActions: {
      async invoke(request: { type: string; [key: string]: unknown }) {
        return {
          type: `${request.type}/result`,
          workspaceId: request.workspaceId ?? workspaceId,
          path: request.path ?? null,
          ok: true,
        };
      },
      async startFileDrag() {
        return { type: "file-actions/drag/start/result", started: true };
      },
      getPathForFile(file: File) {
        return `/tmp/${file.name}`;
      },
    },
    nexusTerminal: {
      async invoke(command: { type: string; workspaceId?: WorkspaceId; tabId?: string }) {
        if (command.type === "terminal/open") {
          counters.terminalOpenCount += 1;
          return {
            type: "terminal/opened",
            tabId: `tt_${command.workspaceId ?? workspaceId}_${counters.terminalOpenCount}`,
            workspaceId: command.workspaceId ?? workspaceId,
            pid: 10_000 + counters.terminalOpenCount,
          };
        }
        if (command.type === "terminal/close") {
          return {
            type: "terminal/exited",
            tabId: command.tabId,
            workspaceId,
            reason: "user-close",
            exitCode: 0,
          };
        }
        if (command.type === "terminal/scrollback-stats/query") {
          return {
            type: "terminal/scrollback-stats/reply",
            tabId: command.tabId,
            mainBufferByteLimit: 0,
            mainBufferStoredBytes: 0,
            mainBufferDroppedBytesTotal: 0,
            xtermScrollbackLines: 0,
          };
        }
        return undefined;
      },
      onEvent(listener: GenericListener): Disposable {
        terminalListeners.add(listener);
        return disposable(() => terminalListeners.delete(listener));
      },
    },
  });
}

function handleEditorInvoke(request: { type: string; [key: string]: unknown }): unknown {
  switch (request.type) {
    case "workspace-files/tree/read":
      counters.treeReadCount += 1;
      return {
        type: "workspace-files/tree/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        rootPath: workspaceRoot,
        nodes: cloneFixtureNodes(),
        readAt: new Date(counters.treeReadCount).toISOString(),
      };
    case "workspace-files/file/read":
      return {
        type: "workspace-files/file/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        content: fixtureFileContent(String(request.path ?? "unknown.ts")),
        encoding: "utf8",
        version: "v1",
        readAt: new Date(0).toISOString(),
      };
    case "workspace-files/file/write":
      return {
        type: "workspace-files/file/write/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        encoding: "utf8",
        version: "v2",
        writtenAt: new Date(0).toISOString(),
      };
    case "workspace-files/file/create":
      return {
        type: "workspace-files/file/create/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        kind: request.kind,
        createdAt: new Date(0).toISOString(),
      };
    case "workspace-files/file/delete":
      return {
        type: "workspace-files/file/delete/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        deletedAt: new Date(0).toISOString(),
      };
    case "workspace-files/file/rename":
      return {
        type: "workspace-files/file/rename/result",
        workspaceId: request.workspaceId ?? workspaceId,
        oldPath: request.oldPath,
        newPath: request.newPath,
        renamedAt: new Date(0).toISOString(),
      };
    case "workspace-git-badges/read":
      return {
        type: "workspace-git-badges/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        badges: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-document/open":
      return {
        type: "lsp-document/open/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        status: lspReadyStatus(request.language),
        openedAt: new Date(0).toISOString(),
      };
    case "lsp-document/change":
      return {
        type: "lsp-document/change/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        status: lspReadyStatus(request.language),
        changedAt: new Date(0).toISOString(),
      };
    case "lsp-document/close":
      return {
        type: "lsp-document/close/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        closedAt: new Date(0).toISOString(),
      };
    case "lsp-diagnostics/read":
      return {
        type: "lsp-diagnostics/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        diagnostics: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-status/read":
      return {
        type: "lsp-status/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        statuses: ["typescript", "python", "go"].map((language) => lspReadyStatus(language)),
        readAt: new Date(0).toISOString(),
      };
    case "lsp-completion/complete":
      return {
        type: "lsp-completion/complete/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        isIncomplete: false,
        items: [],
        completedAt: new Date(0).toISOString(),
      };
    case "lsp-hover/read":
      return {
        type: "lsp-hover/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        contents: [],
        range: null,
        readAt: new Date(0).toISOString(),
      };
    case "lsp-definition/read":
      return {
        type: "lsp-definition/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        targets: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-references/read":
      return {
        type: "lsp-references/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        locations: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-document-symbols/read":
      return {
        type: "lsp-document-symbols/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        symbols: [],
        readAt: new Date(0).toISOString(),
      };
    case "lsp-rename/prepare":
      return {
        type: "lsp-rename/prepare/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        canRename: false,
        range: null,
        placeholder: null,
        defaultBehavior: false,
        preparedAt: new Date(0).toISOString(),
      };
    case "lsp-rename/rename":
      return {
        type: "lsp-rename/rename/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        workspaceEdit: { changes: [] },
        renamedAt: new Date(0).toISOString(),
      };
    case "lsp-formatting/document":
      return {
        type: "lsp-formatting/document/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        edits: [],
        formattedAt: new Date(0).toISOString(),
      };
    case "lsp-formatting/range":
      return {
        type: "lsp-formatting/range/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        edits: [],
        formattedAt: new Date(0).toISOString(),
      };
    case "lsp-signature-help/get":
      return {
        type: "lsp-signature-help/get/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        signatureHelp: null,
        resolvedAt: new Date(0).toISOString(),
      };
    case "lsp-code-action/list":
      return {
        type: "lsp-code-action/list/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path: request.path,
        language: request.language,
        actions: [],
        listedAt: new Date(0).toISOString(),
      };
    default:
      throw new Error(`Unexpected editor bridge request in six group spatial smoke: ${request.type}`);
  }
}

function fixtureFileContent(path: string): string {
  const symbol = path.replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "fixture";
  return `export const ${symbol} = true;\n`;
}

function lspReadyStatus(language: unknown): {
  language: "typescript" | "python" | "go";
  state: "ready";
  serverName: string;
  message: null;
  updatedAt: string;
} {
  const normalizedLanguage = language === "python" || language === "go" ? language : "typescript";
  return {
    language: normalizedLanguage,
    state: "ready",
    serverName: `${normalizedLanguage}-six-group-spatial-smoke`,
    message: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function cloneSidebarState(): WorkspaceSidebarState {
  return {
    openWorkspaces: sidebarState.openWorkspaces.map((workspace) => ({ ...workspace })),
    activeWorkspaceId: sidebarState.activeWorkspaceId,
  };
}

function cloneFixtureNodes(): WorkspaceFileTreeNode[] {
  return fixtureNodes.map((node) => ({ ...node }));
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
  document.documentElement.style.width = "1400px";
  document.documentElement.style.height = "960px";
  document.body.style.width = "1400px";
  document.body.style.height = "960px";
  document.body.style.margin = "0";
  rootElement.style.width = "1400px";
  rootElement.style.height = "960px";
}

function normalizeCssColor(cssColor: string, canvas: HTMLCanvasElement): ParsedColor | null {
  const direct = parseResolvedColor(cssColor);
  if (direct) {
    return direct;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.fillStyle = "#000";
  context.fillStyle = cssColor;
  return parseResolvedColor(context.fillStyle);
}

function parseResolvedColor(color: string): ParsedColor | null {
  const rgbMatch = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgbMatch) {
    return {
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
      a: rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]),
    };
  }

  const modernRgbMatch = color.match(/^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i);
  if (modernRgbMatch) {
    return {
      r: Number(modernRgbMatch[1]),
      g: Number(modernRgbMatch[2]),
      b: Number(modernRgbMatch[3]),
      a: alphaFromCssValue(modernRgbMatch[4]),
    };
  }

  const hexMatch = color.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    const value = hexMatch[1];
    return {
      r: Number.parseInt(value.slice(0, 2), 16),
      g: Number.parseInt(value.slice(2, 4), 16),
      b: Number.parseInt(value.slice(4, 6), 16),
      a: value.length === 8 ? Number.parseInt(value.slice(6, 8), 16) / 255 : 1,
    };
  }

  return parseOklabColor(color) ?? parseOklchColor(color);
}

function alphaFromCssValue(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  if (value.endsWith("%")) {
    return Number(value.slice(0, -1)) / 100;
  }
  return Number(value);
}

function parseOklabColor(color: string): ParsedColor | null {
  const match = color.match(/^oklab\((.+)\)$/i);
  if (!match) {
    return null;
  }

  const { components, alpha } = parseModernColorFunctionBody(match[1]);
  if (components.length < 3) {
    return null;
  }

  return oklabToSrgbColor(
    parseColorNumber(components[0]),
    parseColorNumber(components[1]),
    parseColorNumber(components[2]),
    alpha,
  );
}

function parseOklchColor(color: string): ParsedColor | null {
  const match = color.match(/^oklch\((.+)\)$/i);
  if (!match) {
    return null;
  }

  const { components, alpha } = parseModernColorFunctionBody(match[1]);
  if (components.length < 3) {
    return null;
  }

  const lightness = parseColorNumber(components[0]);
  const chroma = parseColorNumber(components[1]);
  const hueRadians = degreesToRadians(Number.parseFloat(components[2]));

  return oklabToSrgbColor(
    lightness,
    chroma * Math.cos(hueRadians),
    chroma * Math.sin(hueRadians),
    alpha,
  );
}

function parseModernColorFunctionBody(body: string): { components: string[]; alpha: number } {
  const [componentBody, alphaBody] = body.split("/");
  return {
    components: componentBody.trim().split(/\s+/).filter(Boolean),
    alpha: alphaFromCssValue(alphaBody?.trim()),
  };
}

function parseColorNumber(value: string): number {
  if (value.endsWith("%")) {
    return Number.parseFloat(value) / 100;
  }
  return Number.parseFloat(value);
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function oklabToSrgbColor(lightness: number, greenRed: number, blueYellow: number, alpha: number): ParsedColor {
  const lPrime = lightness + 0.3963377774 * greenRed + 0.2158037573 * blueYellow;
  const mPrime = lightness - 0.1055613458 * greenRed - 0.0638541728 * blueYellow;
  const sPrime = lightness - 0.0894841775 * greenRed - 1.2914855480 * blueYellow;

  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const redLinear = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const greenLinear = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blueLinear = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return {
    r: linearSrgbToByte(redLinear),
    g: linearSrgbToByte(greenLinear),
    b: linearSrgbToByte(blueLinear),
    a: clamp01(alpha),
  };
}

function linearSrgbToByte(value: number): number {
  const clamped = clamp01(value);
  const srgb = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * (clamped ** (1 / 2.4)) - 0.055;

  return Math.round(clamp01(srgb) * 255);
}

function compositeOver(foreground: ParsedColor, background: ParsedColor): ParsedColor {
  const alpha = clamp01(foreground.a);
  const inverseAlpha = 1 - alpha;
  return {
    r: foreground.r * alpha + background.r * inverseAlpha,
    g: foreground.g * alpha + background.g * inverseAlpha,
    b: foreground.b * alpha + background.b * inverseAlpha,
    a: 1,
  };
}

function relativeLuminance(color: ParsedColor): number {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const normalized = clamp01(channel / 255);
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundRectValue(value: number): number {
  return Math.round(value * 100) / 100;
}

function disposable(dispose: () => void): Disposable {
  return { dispose };
}

async function waitForSelector(selector: string, timeoutMs = 5_000): Promise<HTMLElement> {
  let latest: HTMLElement | null = null;
  await waitUntil(() => {
    latest = document.querySelector<HTMLElement>(selector);
    return latest !== null;
  }, timeoutMs, () => `Timed out waiting for selector ${selector}`);
  return latest!;
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

function failedResult(reason: string): SixGroupSpatialRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    productionPath: {
      appShellMounted: false,
      editorGroupsPartMounted: false,
      editorGridProvider: null,
      flexlayoutProviderMatched: false,
    },
    sixGroupFixture: {
      baseFiles: [...baseFiles],
      openedTabTitles: [],
      populatedGroupCount: 0,
      topology: "unknown",
      groups: [],
    },
    keyboardContract: {
      expectedBindings,
      expectedCommands,
      bindingByDirection: {
        left: null,
        right: null,
        up: null,
        down: null,
      },
      commandPresentByDirection: {
        left: false,
        right: false,
        up: false,
        down: false,
      },
      missingBindings: Object.values(expectedBindings),
      missingCommands: Object.values(expectedCommands),
    },
    spatialMovement: {
      directionResults: [],
      edgeStopResults: [],
      deterministicContracts: deterministicContractSummaries(),
    },
    visualSanity: {
      threshold: minLuminanceDelta,
      activeGroupId: null,
      inactiveGroupId: null,
      activeBackground: null,
      inactiveBackground: null,
      activeLuminance: null,
      inactiveLuminance: null,
      delta: null,
      passed: false,
      reason,
    },
    t14Dependency: {
      missingSpatialKeyboardImplementation: true,
      missingBindings: Object.values(expectedBindings),
      missingCommands: Object.values(expectedCommands),
      movementFailures: [],
    },
    reason,
  };
}

function formatMovementFailure(result: DirectionMovementResult): string {
  return result.reason ?? `Spatial ${result.direction} movement failed.`;
}

function formatEdgeFailure(result: EdgeStopResult): string {
  return result.reason ?? `Spatial ${result.direction} edge stop failed.`;
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

function publishResult(result: SixGroupSpatialRuntimeSmokeResult): void {
  window.__nexusSixGroupSpatialRuntimeSmokeResult = result;
}
