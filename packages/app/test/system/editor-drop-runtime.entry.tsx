import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceFileKind, WorkspaceFileTreeNode } from "../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace, WorkspaceSidebarState } from "../../../shared/src/contracts/workspace/workspace-shell";
import { installMonacoEnvironment } from "../../src/renderer/editor/monaco-environment";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import "@xterm/xterm/css/xterm.css";

type Disposable = { dispose(): void };
type GenericListener = (event: unknown) => void;
type EditorListener = (event: unknown) => void;
type DropZone = "top" | "right" | "bottom" | "left" | "center" | "top-left" | "top-right" | "bottom-right" | "bottom-left";
type ScenarioStatus = "pass" | "fail";

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface OverlaySnapshot {
  mounted: boolean;
  targetGroupId: string | null;
  targetGroupNumber: number | null;
  edge: string | null;
  cornerZones: boolean;
  folderOnly: boolean;
  rect: RectSnapshot | null;
  activeZones: string[];
  allZones: string[];
  tooltipText: string | null;
  announcement: string;
}

interface DropScenarioResult {
  name: string;
  status: ScenarioStatus;
  path?: string;
  expectedEdge?: string;
  overlay: OverlaySnapshot | null;
  beforeGroupCount: number;
  afterGroupCount: number;
  beforeTabLabels: string[];
  afterTabLabels: string[];
  readPathsDuringScenario: string[];
  reason?: string;
}

interface RectRecalculationResult {
  status: ScenarioStatus;
  firstOverlay: OverlaySnapshot | null;
  secondOverlay: OverlaySnapshot | null;
  firstMatchesTarget: boolean;
  secondMatchesTarget: boolean;
  targetChanged: boolean;
  rapidHoverCount: number;
  reason?: string;
}

interface SplitterHoverResult {
  status: ScenarioStatus;
  splitterFound: boolean;
  overlayMountedAfterHover: boolean;
  reason?: string;
}

interface FolderOnlyResult {
  status: ScenarioStatus;
  overlay: OverlaySnapshot | null;
  tooltipText: string | null;
  dropEffect: string;
  tabCountBefore: number;
  tabCountAfter: number;
  folderTabOpened: boolean;
  reason?: string;
}

interface MultiFileOrderResult {
  status: ScenarioStatus;
  paths: string[];
  readPathsDuringScenario: string[];
  tabLabelIndexes: number[];
  domOrderLabels: string[];
  reason?: string;
}

interface OsFinderDropResult {
  status: ScenarioStatus;
  fileName: string;
  resolvedPath: string;
  expectedWorkspacePath: string;
  readPathsDuringScenario: string[];
  tabOpened: boolean;
  dataTransferMode: string;
  nativeFilesLength: number;
  types: string[];
  limitation: string | null;
  reason?: string;
}

interface EscapeCancelResult {
  status: ScenarioStatus;
  overlayBeforeEscape: OverlaySnapshot | null;
  overlayAfterEscape: OverlaySnapshot | null;
  tabOpened: boolean;
  ariaLiveAfterEscape: string;
  reason?: string;
}

interface AriaLiveResult {
  status: ScenarioStatus;
  centerText: string;
  splitText: string;
  folderText: string;
  clearedAfterEscape: boolean;
  reason?: string;
}

interface EditorDropRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  productionPath: {
    appShellMounted: boolean;
    editorGroupsPartMounted: boolean;
    editorGridProvider: string | null;
    flexlayoutProviderMatched: boolean;
  };
  scenarios: {
    centerDrop: DropScenarioResult;
    rightSplit: DropScenarioResult;
    bottomSplit: DropScenarioResult;
    altCorner: DropScenarioResult;
    splitterHover: SplitterHoverResult;
    rectRecalculation: RectRecalculationResult;
    folderOnly: FolderOnlyResult;
    multiFileOrder: MultiFileOrderResult;
    osFinderExternalPath: OsFinderDropResult;
    escapeCancel: EscapeCancelResult;
    ariaLive: AriaLiveResult;
  };
  dataTransferSynthesis: {
    workspaceMime: string;
    osFileMode: string;
    limitations: string[];
  };
  readPaths: string[];
  reason?: string;
}

interface SyntheticDataTransfer {
  readonly types: readonly string[];
  readonly files?: readonly File[];
  dropEffect: DataTransfer["dropEffect"];
  effectAllowed: DataTransfer["effectAllowed"];
  getData(type: string): string;
  setData(type: string, value: string): void;
}

declare global {
  interface Window {
    __nexusEditorDropRuntimeSmokeResult?: EditorDropRuntimeSmokeResult;
  }
}

const workspaceId = "ws_editor_drop_runtime" as WorkspaceId;
const workspaceRoot = "/tmp/nexus-editor-drop-runtime";
const activeWorkspace: OpenSessionWorkspace = {
  id: workspaceId,
  displayName: "Editor Drop Runtime",
  absolutePath: workspaceRoot,
};
const sidebarState: WorkspaceSidebarState = {
  openWorkspaces: [activeWorkspace],
  activeWorkspaceId: workspaceId,
};
const FILE_TREE_DRAG_MIME = "application/x-nexus-file-tree-node";
const fixtureFilePaths = [
  "alpha.ts",
  "center-drop.ts",
  "right-split.ts",
  "bottom-split.ts",
  "alt-corner.ts",
  "rect-probe.ts",
  "splitter-noop.ts",
  "escape-cancel.ts",
  "docs/one.md",
  "docs/two.md",
  "docs/three.md",
  "src/from-finder.ts",
];
const fixtureNodes: WorkspaceFileTreeNode[] = [
  ...fixtureFilePaths.map((path) => ({
    name: path.split("/").at(-1) ?? path,
    path,
    kind: "file" as const,
  })),
  { name: "folder-only", path: "folder-only", kind: "directory" },
];
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];
const readPaths: string[] = [];
const resolvedExternalPathByFileName = new Map<string, string>();
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
const nativeDropOverlaySelector = '[data-editor-drop-overlay="true"]';
const flexLayoutTabButtonSelector = ".flexlayout__tab_button, .flexlayout__tab_button_stretch";
const rectTolerancePx = 8;

installMonacoEnvironment();
installConsoleCapture();
installPreloadMocks();
void runSmoke();

async function runSmoke(): Promise<void> {
  let osFileMode = "not-run";
  const limitations: string[] = [];

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
    await waitForSelector(`[data-action="file-tree-open-file"][data-path="${fixtureFilePaths[0]}"]`, 10_000);

    await openFixtureFileFromTree("alpha.ts");
    await activateFlexLayoutTabByTitle("alpha.ts");

    const centerDrop = await performWorkspaceFileDropScenario({
      name: "center drop",
      path: "center-drop.ts",
      targetTitle: "alpha.ts",
      zone: "center",
      expectedEdge: "center",
      expectedGroupDelta: 0,
    });
    const centerAriaText = centerDrop.overlay?.announcement ?? "";

    const rightSplit = await performWorkspaceFileDropScenario({
      name: "right split",
      path: "right-split.ts",
      targetTitle: "alpha.ts",
      zone: "right",
      expectedEdge: "right",
      expectedGroupDelta: 1,
    });
    const splitAriaText = rightSplit.overlay?.announcement ?? "";

    const bottomSplit = await performWorkspaceFileDropScenario({
      name: "bottom split",
      path: "bottom-split.ts",
      targetTitle: "alpha.ts",
      zone: "bottom",
      expectedEdge: "bottom",
      expectedGroupDelta: 1,
    });

    const altCorner = await performWorkspaceFileDropScenario({
      name: "Alt corner split",
      path: "alt-corner.ts",
      targetTitle: "alpha.ts",
      zone: "top-left",
      expectedEdge: "top-left",
      expectedGroupDelta: 1,
      altKey: true,
    });

    const splitterHover = await exerciseSplitterHoverDisablesOverlay();
    const rectRecalculation = await exerciseRectRecalculationAndThrottleSanity();
    const folderOnly = await exerciseFolderOnlyNoopTooltip();
    const folderAriaText = folderOnly.overlay?.announcement ?? "";
    const multiFileOrder = await exerciseMultiFileOrder();
    const osFinderExternalPath = await exerciseOsFinderExternalPathDrop();
    osFileMode = osFinderExternalPath.dataTransferMode;
    if (osFinderExternalPath.limitation) {
      limitations.push(osFinderExternalPath.limitation);
    }
    const escapeCancel = await exerciseEscapeCancel();
    const ariaLive = collectAriaLiveResult(centerAriaText, splitAriaText, folderAriaText, escapeCancel);

    const productionPath = collectProductionPathEvidence();
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const scenarioResults = [
      centerDrop,
      rightSplit,
      bottomSplit,
      altCorner,
      splitterHover,
      rectRecalculation,
      folderOnly,
      multiFileOrder,
      osFinderExternalPath,
      escapeCancel,
      ariaLive,
    ];
    const scenarioErrors = scenarioResults
      .filter((scenario) => scenario.status !== "pass")
      .map((scenario) => `${"name" in scenario ? scenario.name : "scenario"}: ${scenario.reason ?? "failed"}`);
    const errors = [...fatalErrors, ...scenarioErrors];
    const ok =
      errors.length === 0 &&
      productionPath.appShellMounted &&
      productionPath.editorGroupsPartMounted &&
      productionPath.editorGridProvider === "flexlayout-model" &&
      productionPath.flexlayoutProviderMatched;

    publishResult({
      ok,
      errors,
      productionPath,
      scenarios: {
        centerDrop,
        rightSplit,
        bottomSplit,
        altCorner,
        splitterHover,
        rectRecalculation,
        folderOnly,
        multiFileOrder,
        osFinderExternalPath,
        escapeCancel,
        ariaLive,
      },
      dataTransferSynthesis: {
        workspaceMime: FILE_TREE_DRAG_MIME,
        osFileMode,
        limitations,
      },
      readPaths: [...readPaths],
      reason:
        errors[0] ??
        (!productionPath.appShellMounted ? "Production AppShell chrome did not mount." : undefined) ??
        (!productionPath.editorGroupsPartMounted ? "Production EditorGroupsPart did not mount." : undefined) ??
        (productionPath.editorGridProvider !== "flexlayout-model"
          ? `Expected data-editor-grid-provider=flexlayout-model, saw ${productionPath.editorGridProvider ?? "<missing>"}`
          : undefined),
    });
  } catch (error) {
    const result = failedResult(stringifyErrorPart(error));
    result.dataTransferSynthesis.osFileMode = osFileMode;
    result.dataTransferSynthesis.limitations = limitations;
    publishResult(result);
  }
}

async function openFixtureFileFromTree(path: string): Promise<void> {
  const button = await waitForSelector(`[data-action="file-tree-open-file"][data-path="${CSS.escape(path)}"]`, 10_000);
  button.click();
  await waitUntil(
    () => visibleEditorTabLabels().includes(path.split("/").at(-1) ?? path),
    10_000,
    () => `Timed out opening ${path}; visible tabs=${visibleEditorTabLabels().join(",")}`,
  );
  await waitForVisibleFlexLayoutContentByTitle(path.split("/").at(-1) ?? path, 5_000);
}

async function performWorkspaceFileDropScenario({
  name,
  path,
  targetTitle,
  zone,
  expectedEdge,
  expectedGroupDelta,
  altKey = false,
}: {
  name: string;
  path: string;
  targetTitle: string;
  zone: DropZone;
  expectedEdge: string;
  expectedGroupDelta: number;
  altKey?: boolean;
}): Promise<DropScenarioResult> {
  await activateFlexLayoutTabByTitle(targetTitle);
  const beforeGroupCount = collectPopulatedGridSlots().length;
  const beforeTabLabels = visibleEditorTabLabelsInDomOrder();
  const beforeReadCount = readPaths.length;
  const transfer = createWorkspaceFileDataTransfer(path, "file");
  const hover = await hoverEditorDrop({ dataTransfer: transfer, targetTitle, zone, altKey });
  const overlay = hover.overlay;

  dispatchDragEventAt("drop", hover.point.x, hover.point.y, transfer, altKey);
  await waitUntil(
    () => visibleEditorTabLabels().includes(path.split("/").at(-1) ?? path),
    10_000,
    () => `Timed out waiting for dropped tab ${path}; visible=${visibleEditorTabLabels().join(",")}`,
  );
  await waitUntil(
    () => currentNativeDropOverlay() === null,
    1_500,
    () => `${name} left native drop overlay mounted after drop`,
  );
  await settleFor(50);

  const afterGroupCount = collectPopulatedGridSlots().length;
  const afterTabLabels = visibleEditorTabLabelsInDomOrder();
  const expectedGroupCount = beforeGroupCount + expectedGroupDelta;
  const pathTitle = path.split("/").at(-1) ?? path;
  const status = overlay.mounted &&
    overlay.edge === expectedEdge &&
    afterTabLabels.includes(pathTitle) &&
    afterGroupCount === expectedGroupCount &&
    (!altKey || overlay.cornerZones)
    ? "pass"
    : "fail";

  return {
    name,
    status,
    path,
    expectedEdge,
    overlay,
    beforeGroupCount,
    afterGroupCount,
    beforeTabLabels,
    afterTabLabels,
    readPathsDuringScenario: readPaths.slice(beforeReadCount),
    reason: status === "pass"
      ? undefined
      : `${name} expected edge=${expectedEdge}, groupCount=${expectedGroupCount}, tab=${pathTitle}; saw edge=${overlay.edge}, cornerZones=${overlay.cornerZones}, groupCount=${afterGroupCount}, labels=${afterTabLabels.join(",")}`,
  };
}

async function exerciseSplitterHoverDisablesOverlay(): Promise<SplitterHoverResult> {
  await cancelNativeDropOverlay();
  const splitter = document.querySelector<HTMLElement>(".flexlayout__splitter, .flexlayout__splitter_extra, .flexlayout__splitter_handle");
  if (!splitter) {
    return {
      status: "fail",
      splitterFound: false,
      overlayMountedAfterHover: currentNativeDropOverlay() !== null,
      reason: "No flexlayout splitter was present after split scenarios.",
    };
  }

  const rect = splitter.getBoundingClientRect();
  const point = rectCenter(rect);
  const transfer = createWorkspaceFileDataTransfer("splitter-noop.ts", "file");
  dispatchDragEventAt("dragenter", point.x, point.y, transfer, false, splitter);
  dispatchDragEventAt("dragover", point.x, point.y, transfer, false, splitter);
  await settleFor(120);

  const overlayMountedAfterHover = currentNativeDropOverlay() !== null;
  return {
    status: overlayMountedAfterHover ? "fail" : "pass",
    splitterFound: true,
    overlayMountedAfterHover,
    reason: overlayMountedAfterHover ? "Native drop overlay mounted while hovering a flexlayout splitter." : undefined,
  };
}

async function exerciseRectRecalculationAndThrottleSanity(): Promise<RectRecalculationResult> {
  await activateFlexLayoutTabByTitle("alpha.ts");
  const transfer = createWorkspaceFileDataTransfer("rect-probe.ts", "file");
  const first = await hoverEditorDrop({ dataTransfer: transfer, targetTitle: "alpha.ts", zone: "center" });
  const firstTargetRect = currentTargetGroupRect(first.overlay.targetGroupId);
  const firstMatchesTarget = Boolean(firstTargetRect && first.overlay.rect && rectMatches(first.overlay.rect, rectSnapshot(firstTargetRect), rectTolerancePx));

  const secondTargetTitle = visibleEditorTabLabels().includes("right-split.ts") ? "right-split.ts" : "bottom-split.ts";
  let latest = first;
  for (let index = 0; index < 6; index += 1) {
    latest = await hoverEditorDrop({
      dataTransfer: transfer,
      targetTitle: index % 2 === 0 ? secondTargetTitle : "alpha.ts",
      zone: index % 2 === 0 ? "bottom" : "right",
    });
  }
  const second = latest.overlay.edge === "bottom"
    ? latest
    : await hoverEditorDrop({ dataTransfer: transfer, targetTitle: secondTargetTitle, zone: "bottom" });
  const secondTargetRect = currentTargetGroupRect(second.overlay.targetGroupId);
  const secondMatchesTarget = Boolean(secondTargetRect && second.overlay.rect && rectMatches(second.overlay.rect, rectSnapshot(secondTargetRect), rectTolerancePx));
  const targetChanged = Boolean(first.overlay.targetGroupId && second.overlay.targetGroupId && first.overlay.targetGroupId !== second.overlay.targetGroupId);
  await cancelNativeDropOverlay();

  const status = firstMatchesTarget && secondMatchesTarget && targetChanged && second.overlay.edge === "bottom" ? "pass" : "fail";
  return {
    status,
    firstOverlay: first.overlay,
    secondOverlay: second.overlay,
    firstMatchesTarget,
    secondMatchesTarget,
    targetChanged,
    rapidHoverCount: 6,
    reason: status === "pass"
      ? undefined
      : `Expected overlay to recalculate from ${first.overlay.targetGroupId} to ${second.overlay.targetGroupId} and match latest target rect; firstMatches=${firstMatchesTarget}, secondMatches=${secondMatchesTarget}, secondEdge=${second.overlay.edge}`,
  };
}

async function exerciseFolderOnlyNoopTooltip(): Promise<FolderOnlyResult> {
  await activateFlexLayoutTabByTitle("alpha.ts");
  const transfer = createWorkspaceFileDataTransfer("folder-only", "directory");
  const tabCountBefore = visibleEditorTabLabelsInDomOrder().length;
  const hover = await hoverEditorDrop({ dataTransfer: transfer, targetTitle: "alpha.ts", zone: "center" });
  const overlay = hover.overlay;
  const dropEffect = transfer.dropEffect;
  dispatchDragEventAt("drop", hover.point.x, hover.point.y, transfer);
  await settleFor(180);
  const tabCountAfter = visibleEditorTabLabelsInDomOrder().length;
  const folderTabOpened = visibleEditorTabLabels().includes("folder-only");
  await cancelNativeDropOverlay();

  const status = overlay.folderOnly &&
    overlay.tooltipText === "Drop files, not folders" &&
    dropEffect === "none" &&
    tabCountAfter === tabCountBefore &&
    !folderTabOpened
    ? "pass"
    : "fail";

  return {
    status,
    overlay,
    tooltipText: overlay.tooltipText,
    dropEffect,
    tabCountBefore,
    tabCountAfter,
    folderTabOpened,
    reason: status === "pass"
      ? undefined
      : `Expected folder-only drop to show tooltip and no-op; folderOnly=${overlay.folderOnly}, tooltip=${overlay.tooltipText}, dropEffect=${dropEffect}, tabCount ${tabCountBefore}->${tabCountAfter}`,
  };
}

async function exerciseMultiFileOrder(): Promise<MultiFileOrderResult> {
  await activateFlexLayoutTabByTitle("alpha.ts");
  const paths = ["docs/one.md", "docs/two.md", "docs/three.md"];
  const beforeReadCount = readPaths.length;
  const transfer = createWorkspaceMultiFileDataTransfer(paths.map((path) => ({ path, kind: "file" })));
  const hover = await hoverEditorDrop({ dataTransfer: transfer, targetTitle: "alpha.ts", zone: "center" });
  dispatchDragEventAt("drop", hover.point.x, hover.point.y, transfer);
  await waitUntil(
    () => paths.every((path) => visibleEditorTabLabels().includes(path.split("/").at(-1) ?? path)),
    10_000,
    () => `Timed out waiting for multi-file tabs; visible=${visibleEditorTabLabels().join(",")}`,
  );
  await waitUntil(
    () => currentNativeDropOverlay() === null,
    1_500,
    () => "Multi-file drop left native drop overlay mounted after drop",
  );
  const labels = visibleEditorTabLabelsInDomOrder();
  const titles = paths.map((path) => path.split("/").at(-1) ?? path);
  const tabLabelIndexes = titles.map((title) => labels.indexOf(title));
  const readPathsDuringScenario = readPaths.slice(beforeReadCount);
  const inDomOrder = tabLabelIndexes.every((index) => index >= 0) &&
    tabLabelIndexes.every((index, position) => position === 0 || index > tabLabelIndexes[position - 1]!);
  const readInOrder = readPathsDuringScenario.join("|") === paths.join("|");
  const status = inDomOrder && readInOrder ? "pass" : "fail";

  return {
    status,
    paths,
    readPathsDuringScenario,
    tabLabelIndexes,
    domOrderLabels: labels,
    reason: status === "pass"
      ? undefined
      : `Expected multi-file drop/read order ${paths.join(",")}; read=${readPathsDuringScenario.join(",")}; indexes=${tabLabelIndexes.join(",")}; labels=${labels.join(",")}`,
  };
}

async function exerciseOsFinderExternalPathDrop(): Promise<OsFinderDropResult> {
  await activateFlexLayoutTabByTitle("alpha.ts");
  const fileName = "from-finder.ts";
  const expectedWorkspacePath = "src/from-finder.ts";
  const resolvedPath = `${workspaceRoot}/${expectedWorkspacePath}`;
  const { dataTransfer, mode, nativeFilesLength, types, limitation } = createOsFileDataTransfer(fileName, resolvedPath);
  const beforeReadCount = readPaths.length;
  const hover = await hoverEditorDrop({ dataTransfer, targetTitle: "alpha.ts", zone: "center" });
  dispatchDragEventAt("drop", hover.point.x, hover.point.y, dataTransfer);
  await waitUntil(
    () => visibleEditorTabLabels().includes(fileName),
    10_000,
    () => `Timed out waiting for OS Finder file tab ${fileName}; visible=${visibleEditorTabLabels().join(",")}`,
  );
  await waitUntil(
    () => currentNativeDropOverlay() === null,
    1_500,
    () => "OS Finder drop left native drop overlay mounted after drop",
  );
  const readPathsDuringScenario = readPaths.slice(beforeReadCount);
  const tabOpened = visibleEditorTabLabels().includes(fileName);
  const status = tabOpened && readPathsDuringScenario.includes(expectedWorkspacePath) ? "pass" : "fail";

  return {
    status,
    fileName,
    resolvedPath,
    expectedWorkspacePath,
    readPathsDuringScenario,
    tabOpened,
    dataTransferMode: mode,
    nativeFilesLength,
    types,
    limitation,
    reason: status === "pass"
      ? undefined
      : `Expected OS file ${resolvedPath} to normalize to ${expectedWorkspacePath}; read=${readPathsDuringScenario.join(",")}, tabOpened=${tabOpened}, mode=${mode}`,
  };
}

async function exerciseEscapeCancel(): Promise<EscapeCancelResult> {
  await activateFlexLayoutTabByTitle("alpha.ts");
  const path = "escape-cancel.ts";
  const transfer = createWorkspaceFileDataTransfer(path, "file");
  const hover = await hoverEditorDrop({ dataTransfer: transfer, targetTitle: "alpha.ts", zone: "right" });
  const overlayBeforeEscape = hover.overlay;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await waitUntil(
    () => currentNativeDropOverlay() === null,
    1_500,
    () => "Escape did not clear native drop overlay",
  );
  await settleFor(150);
  const overlayAfterEscape = currentNativeDropOverlay();
  const tabOpened = visibleEditorTabLabels().includes(path);
  const ariaLiveAfterEscape = ariaLiveText();
  const status = overlayBeforeEscape.mounted && overlayAfterEscape === null && !tabOpened && ariaLiveAfterEscape.length === 0 ? "pass" : "fail";

  return {
    status,
    overlayBeforeEscape,
    overlayAfterEscape,
    tabOpened,
    ariaLiveAfterEscape,
    reason: status === "pass"
      ? undefined
      : `Expected Escape to remove overlay and not open ${path}; afterOverlay=${JSON.stringify(overlayAfterEscape)}, tabOpened=${tabOpened}, ariaLive=${ariaLiveAfterEscape}`,
  };
}

function collectAriaLiveResult(
  centerText: string,
  splitText: string,
  folderText: string,
  escapeCancel: EscapeCancelResult,
): AriaLiveResult {
  const clearedAfterEscape = escapeCancel.ariaLiveAfterEscape.length === 0;
  const centerOk = /Drop into Editor Group \d+/u.test(centerText);
  const splitOk = /Split right of Editor Group \d+/u.test(splitText);
  const folderOk = folderText === "Drop files, not folders";
  const status = centerOk && splitOk && folderOk && clearedAfterEscape ? "pass" : "fail";

  return {
    status,
    centerText,
    splitText,
    folderText,
    clearedAfterEscape,
    reason: status === "pass"
      ? undefined
      : `Unexpected aria-live text: center=${centerText}, split=${splitText}, folder=${folderText}, cleared=${clearedAfterEscape}`,
  };
}

async function hoverEditorDrop({
  dataTransfer,
  targetTitle,
  zone,
  altKey = false,
}: {
  dataTransfer: DataTransfer | SyntheticDataTransfer;
  targetTitle: string;
  zone: DropZone;
  altKey?: boolean;
}): Promise<{ overlay: OverlaySnapshot; point: { x: number; y: number } }> {
  const targetContent = await waitForVisibleFlexLayoutContentByTitle(targetTitle, 5_000);
  const targetGeometry = findGroupGeometryForContent(targetContent, targetTitle);
  const point = hoverPointForZone(targetGeometry.contentRect, zone);
  dispatchDragEventAt("dragenter", point.x, point.y, dataTransfer, altKey);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    dispatchDragEventAt("dragover", point.x, point.y, dataTransfer, altKey);
    await animationFrame();
  }
  const overlay = await waitForNativeDropOverlay(1_000);
  return { overlay, point };
}

function createWorkspaceFileDataTransfer(path: string, kind: WorkspaceFileKind): DataTransfer {
  const dataTransfer = new DataTransfer();
  dataTransfer.effectAllowed = "copyMove";
  dataTransfer.setData(FILE_TREE_DRAG_MIME, JSON.stringify({ workspaceId, path, kind }));
  dataTransfer.setData("text/plain", path);
  return dataTransfer;
}

function createWorkspaceMultiFileDataTransfer(items: { path: string; kind: WorkspaceFileKind }[]): DataTransfer {
  const dataTransfer = new DataTransfer();
  dataTransfer.effectAllowed = "copyMove";
  dataTransfer.setData(FILE_TREE_DRAG_MIME, JSON.stringify({ workspaceId, items }));
  dataTransfer.setData("text/plain", items.map((item) => item.path).join("\n"));
  return dataTransfer;
}

function createOsFileDataTransfer(fileName: string, resolvedPath: string): {
  dataTransfer: DataTransfer | SyntheticDataTransfer;
  mode: string;
  nativeFilesLength: number;
  types: string[];
  limitation: string | null;
} {
  const file = new File([`export const fromFinder = true;\n`], fileName, { type: "text/typescript" });
  resolvedExternalPathByFileName.set(fileName, resolvedPath);

  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.effectAllowed = "copy";
    dataTransfer.items.add(file);
    const nativeFilesLength = dataTransfer.files.length;
    const types = Array.from(dataTransfer.types ?? []);
    if (nativeFilesLength > 0 && types.includes("Files")) {
      return {
        dataTransfer,
        mode: "native-data-transfer-files",
        nativeFilesLength,
        types,
        limitation: null,
      };
    }
  } catch {
    // Fall through to the explicit synthetic DataTransfer path below.
  }

  const synthetic = createSyntheticDataTransfer({ types: ["Files"], files: [file] });
  return {
    dataTransfer: synthetic,
    mode: "synthetic-files-fallback",
    nativeFilesLength: 0,
    types: [...synthetic.types],
    limitation: "Electron/Chromium did not expose a native DataTransfer.files payload for synthetic Finder drops; smoke used a synthetic Event.dataTransfer object plus the existing nexusFileActions.getPathForFile preload API.",
  };
}

function createSyntheticDataTransfer({
  types,
  files = [],
}: {
  types: string[];
  files?: File[];
}): SyntheticDataTransfer {
  const values = new Map<string, string>();
  return {
    types,
    files,
    dropEffect: "none",
    effectAllowed: "all",
    getData(type: string) {
      return values.get(type) ?? "";
    },
    setData(type: string, value: string) {
      values.set(type, value);
      if (!types.includes(type)) {
        types.push(type);
      }
    },
  };
}

function dispatchDragEventAt(
  type: string,
  clientX: number,
  clientY: number,
  dataTransfer: DataTransfer | SyntheticDataTransfer,
  altKey = false,
  explicitTarget?: Element,
): void {
  const section = document.querySelector<HTMLElement>('[data-component="editor-groups-part"]');
  const target = explicitTarget ?? document.elementFromPoint(clientX, clientY) ?? section ?? document.body;
  target.dispatchEvent(createDragEvent(type, clientX, clientY, dataTransfer, altKey));
}

function createDragEvent(
  type: string,
  clientX: number,
  clientY: number,
  dataTransfer: DataTransfer | SyntheticDataTransfer,
  altKey = false,
): DragEvent {
  const isNativeDataTransfer = typeof DataTransfer !== "undefined" && dataTransfer instanceof DataTransfer;
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    altKey,
    ...(isNativeDataTransfer ? { dataTransfer } : {}),
  });

  if (!isNativeDataTransfer || event.dataTransfer !== dataTransfer) {
    Object.defineProperty(event, "dataTransfer", {
      configurable: true,
      value: dataTransfer,
    });
  }

  return event;
}

async function cancelNativeDropOverlay(): Promise<void> {
  if (!currentNativeDropOverlay()) {
    return;
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await waitUntil(
    () => currentNativeDropOverlay() === null,
    1_000,
    () => "Timed out clearing native drop overlay with Escape",
  );
}

async function waitForNativeDropOverlay(timeoutMs: number): Promise<OverlaySnapshot> {
  await waitUntil(
    () => currentNativeDropOverlay() !== null,
    timeoutMs,
    () => `Timed out waiting for native editor drop overlay; ariaLive=${ariaLiveText()}`,
  );
  return currentNativeDropOverlay()!;
}

function currentNativeDropOverlay(): OverlaySnapshot | null {
  const overlay = document.querySelector<HTMLElement>(nativeDropOverlaySelector);
  if (!overlay) {
    return null;
  }

  return {
    mounted: true,
    targetGroupId: overlay.dataset.editorDropTargetGroupId ?? null,
    targetGroupNumber: overlay.dataset.editorDropTargetGroupNumber
      ? Number(overlay.dataset.editorDropTargetGroupNumber)
      : null,
    edge: overlay.dataset.editorDropEdge ?? null,
    cornerZones: overlay.dataset.editorDropCornerZones === "true",
    folderOnly: overlay.dataset.editorDropFolderOnly === "true",
    rect: rectSnapshot(overlay.getBoundingClientRect()),
    activeZones: Array.from(overlay.querySelectorAll<HTMLElement>('[data-editor-drop-zone-active="true"]'))
      .map((zone) => zone.dataset.editorDropZone ?? "")
      .filter(Boolean),
    allZones: Array.from(overlay.querySelectorAll<HTMLElement>("[data-editor-drop-zone]"))
      .map((zone) => zone.dataset.editorDropZone ?? "")
      .filter(Boolean),
    tooltipText: overlay.querySelector<HTMLElement>('[data-editor-drop-folder-tooltip="true"]')?.textContent?.trim() ?? null,
    announcement: ariaLiveText(),
  };
}

function ariaLiveText(): string {
  return document.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]')?.textContent?.trim() ?? "";
}

function collectProductionPathEvidence(): EditorDropRuntimeSmokeResult["productionPath"] {
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

function collectGridSlots(): Array<{
  index: number;
  groupId: string;
  tabCount: number;
  activeTabId: string;
}> {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-editor-grid-slot]"))
    .map((element) => ({
      index: Number(element.dataset.editorGridSlot ?? "0"),
      groupId: element.dataset.editorGroupId ?? "",
      tabCount: Number(element.dataset.editorGroupTabCount ?? "0"),
      activeTabId: element.dataset.editorGroupActiveTabId ?? "",
    }))
    .sort((left, right) => left.index - right.index);
}

function collectPopulatedGridSlots(): ReturnType<typeof collectGridSlots> {
  return collectGridSlots().filter((slot) => slot.groupId.length > 0 && slot.tabCount > 0);
}

async function activateFlexLayoutTabByTitle(title: string): Promise<void> {
  const button = await waitForFlexLayoutTabButtonByTitle(title, 5_000);
  button.click();
  await waitForVisibleFlexLayoutContentByTitle(title, 5_000);
  await animationFrame();
}

async function waitForFlexLayoutTabButtonByTitle(title: string, timeoutMs: number): Promise<HTMLElement> {
  let latest: HTMLElement | null = null;
  await waitUntil(() => {
    latest = flexLayoutTabButtonByTitle(title);
    return latest !== null;
  }, timeoutMs, () => `Timed out waiting for flexlayout tab button ${title}; visible=${visibleEditorTabLabels().join(",")}`);
  return latest!;
}

function flexLayoutTabButtonByTitle(title: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(flexLayoutTabButtonSelector))
    .filter(isVisibleElement)
    .find((button) => button.textContent?.includes(title) === true) ?? null;
}

async function waitForVisibleFlexLayoutContentByTitle(title: string, timeoutMs: number): Promise<HTMLElement> {
  let latest: HTMLElement | null = null;
  await waitUntil(() => {
    latest = visibleFlexLayoutContentByTitle(title);
    return latest !== null;
  }, timeoutMs, () => `Timed out waiting for visible flexlayout content ${title}; content=${visibleFlexLayoutContentSummaries().join(" | ")}`);
  return latest!;
}

function visibleFlexLayoutContentByTitle(title: string): HTMLElement | null {
  const tabId = layoutTabIdByTitle(title);
  if (!tabId) {
    return null;
  }

  return Array.from(document.querySelectorAll<HTMLElement>('[data-editor-flexlayout-tab-content="true"]'))
    .filter(isVisibleElement)
    .find((content) => content.dataset.editorGroupTabId === tabId) ?? null;
}

function layoutTabIdByTitle(title: string): string | null {
  const layoutTab = Array.from(document.querySelectorAll<HTMLElement>('[data-editor-layout-tab="true"]'))
    .filter(isVisibleElement)
    .find((tab) => tab.textContent?.includes(title) === true) ?? null;
  return layoutTab?.dataset.editorLayoutTabId ?? null;
}

function visibleFlexLayoutContentSummaries(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-editor-flexlayout-tab-content="true"]'))
    .filter(isVisibleElement)
    .map((content) => `${content.dataset.editorGroupId ?? "<no-group>"}:${(content.textContent ?? "").slice(0, 80)}`);
}

function visibleEditorTabLabels(): string[] {
  return visibleEditorTabLabelsInDomOrder().sort();
}

function visibleEditorTabLabelsInDomOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-editor-layout-tab-label="true"]'))
    .filter(isVisibleElement)
    .map((element) => element.textContent?.trim() ?? "")
    .filter(Boolean);
}

function findGroupGeometryForContent(targetContent: HTMLElement, title: string): {
  groupRect: DOMRect;
  contentRect: DOMRect;
} {
  const targetRect = targetContent.getBoundingClientRect();
  const targetCenter = rectCenter(targetRect);
  const tabsetContainers = Array.from(document.querySelectorAll<HTMLElement>(".flexlayout__tabset_container"))
    .filter(isVisibleElement);
  const ranked = tabsetContainers
    .map((element) => {
      const groupRect = element.getBoundingClientRect();
      const contentElement = element.querySelector<HTMLElement>(".flexlayout__tabset_content");
      const contentRect = contentElement?.getBoundingClientRect() ?? groupRect;
      return {
        element,
        groupRect,
        contentRect,
        containsTargetCenter: rectContainsPoint(groupRect, targetCenter.x, targetCenter.y),
        intersectionArea: rectIntersectionArea(groupRect, targetRect),
      };
    })
    .sort((left, right) => {
      if (left.containsTargetCenter !== right.containsTargetCenter) {
        return left.containsTargetCenter ? -1 : 1;
      }
      return right.intersectionArea - left.intersectionArea;
    });

  const best = ranked[0];
  if (!best || best.intersectionArea <= 0) {
    throw new Error(
      `Could not resolve active flexlayout tabset for ${title}; targetRect=${JSON.stringify(rectSnapshot(targetRect))} candidates=${ranked.length}`,
    );
  }

  return {
    groupRect: best.groupRect,
    contentRect: best.contentRect,
  };
}

function currentTargetGroupRect(groupId: string | null): DOMRect | null {
  if (!groupId) {
    return null;
  }

  const content = Array.from(document.querySelectorAll<HTMLElement>('[data-editor-flexlayout-tab-content="true"]'))
    .find((element) => element.dataset.editorGroupId === groupId) ?? null;
  if (!content) {
    return null;
  }

  return findGroupGeometryForContent(content, groupId).groupRect;
}

function hoverPointForZone(contentRect: DOMRect, zone: DropZone): { x: number; y: number } {
  const xAt = (ratio: number) => contentRect.left + contentRect.width * ratio;
  const yAt = (ratio: number) => contentRect.top + contentRect.height * ratio;

  switch (zone) {
    case "top-left":
      return { x: xAt(0.12), y: yAt(0.12) };
    case "top-right":
      return { x: xAt(0.88), y: yAt(0.12) };
    case "bottom-right":
      return { x: xAt(0.88), y: yAt(0.88) };
    case "bottom-left":
      return { x: xAt(0.12), y: yAt(0.88) };
    case "top":
      return { x: xAt(0.5), y: yAt(0.12) };
    case "right":
      return { x: xAt(0.88), y: yAt(0.5) };
    case "bottom":
      return { x: xAt(0.5), y: yAt(0.88) };
    case "left":
      return { x: xAt(0.12), y: yAt(0.5) };
    case "center":
      return { x: xAt(0.5), y: yAt(0.5) };
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

function rectMatches(actual: RectSnapshot, expected: RectSnapshot, tolerance: number): boolean {
  return Math.abs(actual.left - expected.left) <= tolerance &&
    Math.abs(actual.top - expected.top) <= tolerance &&
    Math.abs(actual.width - expected.width) <= tolerance &&
    Math.abs(actual.height - expected.height) <= tolerance &&
    Math.abs(actual.right - expected.right) <= tolerance &&
    Math.abs(actual.bottom - expected.bottom) <= tolerance;
}

function roundRectNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function rectCenter(rect: DOMRect | DOMRectReadOnly): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function rectContainsPoint(rect: DOMRect | DOMRectReadOnly, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function rectIntersectionArea(leftRect: DOMRect | DOMRectReadOnly, rightRect: DOMRect | DOMRectReadOnly): number {
  const left = Math.max(leftRect.left, rightRect.left);
  const right = Math.min(leftRect.right, rightRect.right);
  const top = Math.max(leftRect.top, rightRect.top);
  const bottom = Math.min(leftRect.bottom, rightRect.bottom);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    style.display !== "none" &&
    style.visibility !== "hidden"
  );
}

function installPreloadMocks(): void {
  Object.assign(window, {
    nexusEnvironment: {
      platform: "darwin",
    },
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
          requestId: command.requestId ?? "editor-drop-search-request",
          workspaceId: command.workspaceId ?? workspaceId,
          message: "Search is disabled in editor drop smoke.",
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
          requestId: request.requestId ?? `editor-drop-${request.action}`,
          workspaceId: request.workspaceId ?? workspaceId,
          message: "Git is disabled in editor drop smoke.",
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
        const pathForName = resolvedExternalPathByFileName.get(file.name);
        if (pathForName) {
          return pathForName;
        }

        const pathForBasename = Array.from(resolvedExternalPathByFileName.entries())
          .find(([name]) => file.name.endsWith(name))?.[1];
        if (pathForBasename) {
          return pathForBasename;
        }

        const onlyRegisteredPath = resolvedExternalPathByFileName.size === 1
          ? Array.from(resolvedExternalPathByFileName.values())[0]
          : null;
        return onlyRegisteredPath ?? `/tmp/${file.name}`;
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
            pid: 30_000 + counters.terminalOpenCount,
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
    case "workspace-files/file/read": {
      const path = String(request.path ?? "unknown.ts");
      readPaths.push(path);
      return {
        type: "workspace-files/file/read/result",
        workspaceId: request.workspaceId ?? workspaceId,
        path,
        content: fixtureFileContent(path),
        encoding: "utf8",
        version: `v:${path}:${readPaths.length}`,
        readAt: new Date(readPaths.length).toISOString(),
      };
    }
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
      throw new Error(`Unexpected editor bridge request in editor drop smoke: ${request.type}`);
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
    serverName: `${normalizedLanguage}-editor-drop-smoke`,
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
  document.documentElement.style.height = "1000px";
  document.body.style.width = "1400px";
  document.body.style.height = "1000px";
  document.body.style.margin = "0";
  rootElement.style.width = "1400px";
  rootElement.style.height = "1000px";
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

function failedScenario(name: string, reason: string): DropScenarioResult {
  return {
    name,
    status: "fail",
    overlay: null,
    beforeGroupCount: 0,
    afterGroupCount: 0,
    beforeTabLabels: [],
    afterTabLabels: [],
    readPathsDuringScenario: [],
    reason,
  };
}

function failedResult(reason: string): EditorDropRuntimeSmokeResult {
  const failedDrop = failedScenario("not-run", reason);
  return {
    ok: false,
    errors: [reason],
    productionPath: {
      appShellMounted: false,
      editorGroupsPartMounted: false,
      editorGridProvider: null,
      flexlayoutProviderMatched: false,
    },
    scenarios: {
      centerDrop: { ...failedDrop, name: "center drop" },
      rightSplit: { ...failedDrop, name: "right split" },
      bottomSplit: { ...failedDrop, name: "bottom split" },
      altCorner: { ...failedDrop, name: "Alt corner split" },
      splitterHover: { status: "fail", splitterFound: false, overlayMountedAfterHover: false, reason },
      rectRecalculation: {
        status: "fail",
        firstOverlay: null,
        secondOverlay: null,
        firstMatchesTarget: false,
        secondMatchesTarget: false,
        targetChanged: false,
        rapidHoverCount: 0,
        reason,
      },
      folderOnly: {
        status: "fail",
        overlay: null,
        tooltipText: null,
        dropEffect: "none",
        tabCountBefore: 0,
        tabCountAfter: 0,
        folderTabOpened: false,
        reason,
      },
      multiFileOrder: {
        status: "fail",
        paths: [],
        readPathsDuringScenario: [],
        tabLabelIndexes: [],
        domOrderLabels: [],
        reason,
      },
      osFinderExternalPath: {
        status: "fail",
        fileName: "",
        resolvedPath: "",
        expectedWorkspacePath: "",
        readPathsDuringScenario: [],
        tabOpened: false,
        dataTransferMode: "not-run",
        nativeFilesLength: 0,
        types: [],
        limitation: null,
        reason,
      },
      escapeCancel: {
        status: "fail",
        overlayBeforeEscape: null,
        overlayAfterEscape: null,
        tabOpened: false,
        ariaLiveAfterEscape: "",
        reason,
      },
      ariaLive: {
        status: "fail",
        centerText: "",
        splitText: "",
        folderText: "",
        clearedAfterEscape: false,
        reason,
      },
    },
    dataTransferSynthesis: {
      workspaceMime: FILE_TREE_DRAG_MIME,
      osFileMode: "not-run",
      limitations: [],
    },
    readPaths: [...readPaths],
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

function publishResult(result: EditorDropRuntimeSmokeResult): void {
  window.__nexusEditorDropRuntimeSmokeResult = result;
}
