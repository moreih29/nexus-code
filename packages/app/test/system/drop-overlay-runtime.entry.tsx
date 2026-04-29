import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { WorkspaceFileTreeNode } from "../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace, WorkspaceSidebarState } from "../../../shared/src/contracts/workspace/workspace-shell";
import { installMonacoEnvironment } from "../../src/renderer/editor/monaco-environment";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import "@xterm/xterm/css/xterm.css";

type Disposable = { dispose(): void };
type GenericListener = (event: unknown) => void;
type EditorListener = (event: unknown) => void;
type DropZone = "top" | "right" | "bottom" | "left" | "center";

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface DropOverlayZoneProbe {
  zone: DropZone;
  matched: boolean;
  visibleWithinMs: number;
  activeGroupRect: RectSnapshot;
  expectedIndicatorRect: RectSnapshot;
  actualIndicatorRect: RectSnapshot;
  deltaPx: RectSnapshot;
  indicatorClassName: string;
  borderColor: string;
  backgroundColor: string;
  indicatorCountAfterDragEnd: number;
  reason?: string;
}

interface DropOverlayRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  productionPath: {
    appShellMounted: boolean;
    editorGroupsPartMounted: boolean;
    editorGridProvider: string | null;
    flexlayoutProviderMatched: boolean;
  };
  fourPaneScenario: {
    fixtureFiles: string[];
    openedTabTitles: string[];
    finalGridPaneCount: number;
    finalGridTabCount: number;
    activeGroupId: string;
    sourceTabTitle: string;
    targetTabTitle: string;
  };
  overlay: {
    hoverBudgetMs: number;
    tolerancePx: number;
    zones: DropOverlayZoneProbe[];
    finalIndicatorCount: number;
  };
  reason?: string;
}

declare global {
  interface Window {
    __nexusDropOverlayRuntimeSmokeResult?: DropOverlayRuntimeSmokeResult;
  }
}

const workspaceId = "ws_drop_overlay_runtime" as WorkspaceId;
const workspaceRoot = "/tmp/nexus-drop-overlay-runtime";
const activeWorkspace: OpenSessionWorkspace = {
  id: workspaceId,
  displayName: "Drop Overlay Runtime",
  absolutePath: workspaceRoot,
};
const sidebarState: WorkspaceSidebarState = {
  openWorkspaces: [activeWorkspace],
  activeWorkspaceId: workspaceId,
};
const fixtureFiles = ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts"];
const targetTabTitle = "alpha.ts";
const sourceTabTitle = "delta.ts";
const dropZones: DropZone[] = ["top", "right", "bottom", "left", "center"];
const hoverBudgetMs = 200;
const tolerancePx = 6;
const fixtureNodes: WorkspaceFileTreeNode[] = fixtureFiles.map((path) => ({
  name: path,
  path,
  kind: "file",
}));
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
const indicatorSelector = ".flexlayout__outline_rect, .flexlayout__outline_rect_edge";
const flexLayoutTabButtonSelector = ".flexlayout__tab_button, .flexlayout__tab_button_stretch";

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
    await waitForSelector(`[data-action="file-tree-open-file"][data-path="${fixtureFiles[0]}"]`, 10_000);

    const fourPaneScenario = await mountFourPaneEditorGroupsScenario();
    const productionPath = collectProductionPathEvidence();
    const overlay = await exerciseDropOverlayZones();
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const failedZone = overlay.zones.find((zone) => !zone.matched || zone.visibleWithinMs > hoverBudgetMs || zone.indicatorCountAfterDragEnd !== 0);
    const ok =
      fatalErrors.length === 0 &&
      productionPath.appShellMounted &&
      productionPath.editorGroupsPartMounted &&
      productionPath.editorGridProvider === "flexlayout-model" &&
      productionPath.flexlayoutProviderMatched &&
      fourPaneScenario.finalGridPaneCount === 4 &&
      fourPaneScenario.finalGridTabCount === fixtureFiles.length &&
      overlay.zones.length === dropZones.length &&
      !failedZone &&
      overlay.finalIndicatorCount === 0;

    publishResult({
      ok,
      errors: fatalErrors,
      productionPath,
      fourPaneScenario,
      overlay,
      reason:
        fatalErrors[0] ??
        (!productionPath.appShellMounted ? "Production AppShell chrome did not mount." : undefined) ??
        (!productionPath.editorGroupsPartMounted ? "Production EditorGroupsPart did not mount." : undefined) ??
        (productionPath.editorGridProvider !== "flexlayout-model"
          ? `Expected data-editor-grid-provider=flexlayout-model, saw ${productionPath.editorGridProvider ?? "<missing>"}`
          : undefined) ??
        (fourPaneScenario.finalGridPaneCount !== 4
          ? `Expected 4 populated flexlayout panes, saw ${fourPaneScenario.finalGridPaneCount}.`
          : undefined) ??
        (fourPaneScenario.finalGridTabCount !== fixtureFiles.length
          ? `Expected ${fixtureFiles.length} flexlayout tabs, saw ${fourPaneScenario.finalGridTabCount}.`
          : undefined) ??
        failedZone?.reason ??
        (overlay.finalIndicatorCount !== 0
          ? `Expected drag end to leave 0 indicators mounted, saw ${overlay.finalIndicatorCount}.`
          : undefined),
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

async function mountFourPaneEditorGroupsScenario(): Promise<DropOverlayRuntimeSmokeResult["fourPaneScenario"]> {
  for (const filePath of fixtureFiles) {
    const button = await waitForSelector(`[data-action="file-tree-open-file"][data-path="${CSS.escape(filePath)}"]`, 10_000);
    button.click();
    await waitUntil(
      () => visibleEditorTabTitles().includes(filePath),
      10_000,
      () => `Timed out opening ${filePath}; visible tabs=${visibleEditorTabTitles().join(",")}`,
    );
  }

  await activateEditorTabByTitle(sourceTabTitle);
  for (let index = 0; index < 3; index += 1) {
    dispatchCommandShortcut("\\");
    await settleFor(120);
  }

  await waitUntil(
    () => collectPopulatedGridSlots().length === 4,
    5_000,
    () => `Expected 4 populated grid slots after split commands; saw ${JSON.stringify(collectGridSlots())}`,
  );
  await activateFlexLayoutTabByTitle(targetTabTitle);

  const targetContent = await waitForVisibleFlexLayoutContentByTitle(targetTabTitle, 5_000);
  const populatedGridSlots = collectPopulatedGridSlots();
  const openedTabTitles = visibleEditorTabTitles();

  return {
    fixtureFiles: [...fixtureFiles],
    openedTabTitles,
    finalGridPaneCount: populatedGridSlots.length,
    finalGridTabCount: populatedGridSlots.reduce((sum, slot) => sum + slot.tabCount, 0),
    activeGroupId: targetContent.dataset.editorGroupId ?? "",
    sourceTabTitle,
    targetTabTitle,
  };
}

async function exerciseDropOverlayZones(): Promise<DropOverlayRuntimeSmokeResult["overlay"]> {
  const zones: DropOverlayZoneProbe[] = [];

  for (const zone of dropZones) {
    await activateFlexLayoutTabByTitle(targetTabTitle);
    await settleFor(50);
    const sourceButton = await waitForFlexLayoutTabButtonByTitle(sourceTabTitle, 5_000);
    const targetContent = await waitForVisibleFlexLayoutContentByTitle(targetTabTitle, 5_000);
    const activeGroup = findActiveGroupGeometry(targetContent);
    const expectedIndicatorRect = expectedIndicatorRectForZone(activeGroup.groupRect, zone);
    const hoverPoint = hoverPointForZone(activeGroup.contentRect, zone);
    const dragData = new DataTransfer();
    const sourceRect = sourceButton.getBoundingClientRect();
    const sourcePoint = {
      x: sourceRect.left + sourceRect.width / 2,
      y: sourceRect.top + sourceRect.height / 2,
    };

    clearMountedIndicators();
    sourceButton.dispatchEvent(createDragEvent("dragstart", sourcePoint.x, sourcePoint.y, dragData));
    const layout = await waitForSelector(".flexlayout__layout", 5_000);
    const dragEnterEvent = createDragEvent("dragenter", hoverPoint.x, hoverPoint.y, dragData);
    (document.elementFromPoint(hoverPoint.x, hoverPoint.y) ?? layout).dispatchEvent(dragEnterEvent);
    const hoverStartedAt = performance.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dragOverEvent = createDragEvent("dragover", hoverPoint.x, hoverPoint.y, dragData);
      (document.elementFromPoint(hoverPoint.x, hoverPoint.y) ?? layout).dispatchEvent(dragOverEvent);
      layout.dispatchEvent(createDragEvent("dragover", hoverPoint.x, hoverPoint.y, dragData));
      await animationFrame();
    }

    const indicator = await waitForVisibleIndicator(hoverBudgetMs);
    const visibleWithinMs = performance.now() - hoverStartedAt;
    const expected = rectSnapshot(expectedIndicatorRect);
    await waitUntil(
      () => rectMatches(rectSnapshot(indicator.getBoundingClientRect()), expected, tolerancePx),
      700,
      () => `${zone} indicator stayed visible but did not settle into the expected active group zone. expected=${JSON.stringify(expected)} actual=${JSON.stringify(rectSnapshot(indicator.getBoundingClientRect()))}`,
    );
    const actualIndicatorRect = rectSnapshot(indicator.getBoundingClientRect());
    const activeGroupRect = rectSnapshot(activeGroup.groupRect);
    const deltaPx = rectDelta(actualIndicatorRect, expected);
    const matched = rectMatches(actualIndicatorRect, expected, tolerancePx);
    const styles = getComputedStyle(indicator);
    const borderColor = styles.borderColor;
    const backgroundColor = styles.backgroundColor;
    const reason = matched
      ? undefined
      : `${zone} indicator did not match active group rect. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actualIndicatorRect)} delta=${JSON.stringify(deltaPx)}`;

    sourceButton.dispatchEvent(createDragEvent("dragend", hoverPoint.x, hoverPoint.y, dragData));
    await waitUntil(
      () => mountedIndicatorCount() === 0,
      1_000,
      () => `${zone} drag end left ${mountedIndicatorCount()} indicators mounted`,
    );

    zones.push({
      zone,
      matched,
      visibleWithinMs,
      activeGroupRect,
      expectedIndicatorRect: expected,
      actualIndicatorRect,
      deltaPx,
      indicatorClassName: indicator.className,
      borderColor,
      backgroundColor,
      indicatorCountAfterDragEnd: mountedIndicatorCount(),
      reason,
    });
  }

  return {
    hoverBudgetMs,
    tolerancePx,
    zones,
    finalIndicatorCount: mountedIndicatorCount(),
  };
}

function collectProductionPathEvidence(): DropOverlayRuntimeSmokeResult["productionPath"] {
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

async function activateEditorTabByTitle(title: string): Promise<void> {
  await waitUntil(
    () => editorTabButtonByTitle(title) !== null,
    5_000,
    () => `Timed out waiting for editor tab ${title}; visible tabs=${visibleEditorTabTitles().join(",")}`,
  );
  editorTabButtonByTitle(title)?.click();
  await animationFrame();
}

function editorTabButtonByTitle(title: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-action="editor-activate-tab"]'))
    .find((button) => button.textContent?.includes(title) === true) ?? null;
}

function visibleEditorTabTitles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-editor-tab-title-active]"))
    .filter(isVisibleElement)
    .map((element) => element.textContent?.trim() ?? "")
    .filter(Boolean)
    .sort();
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
  }, timeoutMs, () => `Timed out waiting for flexlayout tab button ${title}; visible=${visibleFlexLayoutTabButtonTitles().join(",")}`);
  return latest!;
}

function flexLayoutTabButtonByTitle(title: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(flexLayoutTabButtonSelector))
    .filter(isVisibleElement)
    .find((button) => button.textContent?.includes(title) === true) ?? null;
}

function visibleFlexLayoutTabButtonTitles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(flexLayoutTabButtonSelector))
    .filter(isVisibleElement)
    .map((button) => button.textContent?.trim() ?? "")
    .filter(Boolean)
    .sort();
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
  return Array.from(document.querySelectorAll<HTMLElement>('[data-editor-flexlayout-tab-content="true"]'))
    .filter(isVisibleElement)
    .find((content) => content.textContent?.includes(title) === true) ?? null;
}

function visibleFlexLayoutContentSummaries(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-editor-flexlayout-tab-content="true"]'))
    .filter(isVisibleElement)
    .map((content) => `${content.dataset.editorGroupId ?? "<no-group>"}:${(content.textContent ?? "").slice(0, 80)}`);
}

function findActiveGroupGeometry(targetContent: HTMLElement): {
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
      `Could not resolve active flexlayout tabset for ${targetTabTitle}; targetRect=${JSON.stringify(rectSnapshot(targetRect))} candidates=${ranked.length}`,
    );
  }

  return {
    groupRect: best.groupRect,
    contentRect: best.contentRect,
  };
}

function expectedIndicatorRectForZone(groupRect: DOMRect, zone: DropZone): DOMRect {
  switch (zone) {
    case "top":
      return domRect(groupRect.left, groupRect.top, groupRect.width, groupRect.height / 2);
    case "right":
      return domRect(groupRect.left + groupRect.width / 2, groupRect.top, groupRect.width / 2, groupRect.height);
    case "bottom":
      return domRect(groupRect.left, groupRect.top + groupRect.height / 2, groupRect.width, groupRect.height / 2);
    case "left":
      return domRect(groupRect.left, groupRect.top, groupRect.width / 2, groupRect.height);
    case "center":
      return domRect(groupRect.left, groupRect.top, groupRect.width, groupRect.height);
  }
}

function hoverPointForZone(contentRect: DOMRect, zone: DropZone): { x: number; y: number } {
  const xAt = (ratio: number) => contentRect.left + contentRect.width * ratio;
  const yAt = (ratio: number) => contentRect.top + contentRect.height * ratio;

  switch (zone) {
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

async function waitForVisibleIndicator(timeoutMs: number): Promise<HTMLElement> {
  let latest: HTMLElement | null = null;
  await waitUntil(() => {
    latest = visibleIndicator();
    return latest !== null;
  }, timeoutMs, () => `Timed out waiting ${timeoutMs}ms for visible drop indicator; mounted=${mountedIndicatorCount()}`);
  return latest!;
}

function visibleIndicator(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(indicatorSelector))
    .find((indicator) => {
      const rect = indicator.getBoundingClientRect();
      const style = getComputedStyle(indicator);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }) ?? null;
}

function mountedIndicatorCount(): number {
  return document.querySelectorAll(indicatorSelector).length;
}

function clearMountedIndicators(): void {
  for (const indicator of Array.from(document.querySelectorAll(indicatorSelector))) {
    indicator.remove();
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

function rectDelta(actual: RectSnapshot, expected: RectSnapshot): RectSnapshot {
  return {
    left: roundRectNumber(actual.left - expected.left),
    top: roundRectNumber(actual.top - expected.top),
    width: roundRectNumber(actual.width - expected.width),
    height: roundRectNumber(actual.height - expected.height),
    right: roundRectNumber(actual.right - expected.right),
    bottom: roundRectNumber(actual.bottom - expected.bottom),
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

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
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
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function createDragEvent(type: string, clientX: number, clientY: number, dataTransfer: DataTransfer): DragEvent {
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    dataTransfer,
  });
}

function dispatchCommandShortcut(key: string): void {
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    code: key === "\\" ? "Backslash" : key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  }));
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
          requestId: command.requestId ?? "drop-overlay-search-request",
          workspaceId: command.workspaceId ?? workspaceId,
          message: "Search is disabled in drop overlay smoke.",
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
          requestId: request.requestId ?? `drop-overlay-${request.action}`,
          workspaceId: request.workspaceId ?? workspaceId,
          message: "Git is disabled in drop overlay smoke.",
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
            pid: 20_000 + counters.terminalOpenCount,
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
      throw new Error(`Unexpected editor bridge request in drop overlay smoke: ${request.type}`);
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
    serverName: `${normalizedLanguage}-drop-overlay-smoke`,
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
  document.documentElement.style.width = "1280px";
  document.documentElement.style.height = "900px";
  document.body.style.width = "1280px";
  document.body.style.height = "900px";
  document.body.style.margin = "0";
  rootElement.style.width = "1280px";
  rootElement.style.height = "900px";
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

function failedResult(reason: string): DropOverlayRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    productionPath: {
      appShellMounted: false,
      editorGroupsPartMounted: false,
      editorGridProvider: null,
      flexlayoutProviderMatched: false,
    },
    fourPaneScenario: {
      fixtureFiles: [...fixtureFiles],
      openedTabTitles: [],
      finalGridPaneCount: 0,
      finalGridTabCount: 0,
      activeGroupId: "",
      sourceTabTitle,
      targetTabTitle,
    },
    overlay: {
      hoverBudgetMs,
      tolerancePx,
      zones: [],
      finalIndicatorCount: mountedIndicatorCount(),
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

function publishResult(result: DropOverlayRuntimeSmokeResult): void {
  window.__nexusDropOverlayRuntimeSmokeResult = result;
}
