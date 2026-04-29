import { StrictMode, createElement, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import { CenterWorkbench } from "../../src/renderer/components/CenterWorkbench";
import { EditorGroupsPart } from "../../src/renderer/parts/editor-groups/EditorGroupsPart";
import {
  createEditorGroupsService,
  type EditorGroup,
  type EditorGroupTab,
  type EditorGroupsServiceStore,
} from "../../src/renderer/services/editor-groups-service";
import {
  monacoLanguageIdForPath,
  type EditorPaneId,
  type EditorPaneState,
  type EditorTab,
  type EditorTabId,
} from "../../src/renderer/services/editor-types";
import { installMonacoEnvironment } from "../../src/renderer/editor/monaco-environment";
import { XtermView } from "../../src/renderer/terminal/xterm-view";
import { XTERM_IME_OVERLAY_CLASS } from "../../src/renderer/terminal/xterm-ime-overlay";
import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import "@xterm/xterm/css/xterm.css";

type ScenarioName =
  | "monaco-editor-drag-tab-cycle"
  | "xterm-korean-input-around-dock-move"
  | "xterm-ime-overlay-rebind-after-terminal-move"
  | "splitter-pointermove-during-composition";

type TargetKind = "monaco" | "xterm";
type TerminalDockLocation = "bottom" | "editor";

interface CompositionSpySummary {
  starts: number;
  updates: number;
  ends: number;
  cancelCount: number;
  forcedFinishCount: number;
  blurWhileComposingCount: number;
  unmountDuringCompositionCount: number;
  startSessionId: number | null;
  endSessionId: number | null;
  finalCommittedText: string | null;
  targetConnectedAtEnd: boolean;
}

interface ScenarioResult {
  name: ScenarioName;
  passed: boolean;
  targetKind: TargetKind;
  sameCompositionSession: boolean;
  composition: CompositionSpySummary;
  operationLog: string[];
  reason?: string;
}

interface ImeDockPreservationRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  scenarios: ScenarioResult[];
  aggregate: {
    scenarioCount: number;
    passedScenarioCount: number;
    totalCompositionCancelCount: number;
    totalForcedFinishCount: number;
    allSameCompositionSession: boolean;
  };
  latency: {
    sampleCount: number;
    samplesMs: number[];
    p95Ms: number;
    thresholdSource: "design.md";
    thresholdMs: number | null;
    thresholdFound: boolean;
  };
  limitations: string[];
  reason?: string;
}

interface PointerLikeInit {
  pointerId: number;
  clientX: number;
  clientY: number;
  buttons?: number;
}

declare global {
  interface Window {
    __nexusImeDockPreservationRuntimeSmokeResult?: ImeDockPreservationRuntimeSmokeResult;
  }
}

const workspaceId = "ws_ime_dock_preservation" as WorkspaceId;
const editorGroupsService = createEditorGroupsService();
const terminalInputs: string[] = [];
const terminalCompositionRuntime: {
  view: XtermView | null;
  currentHost: HTMLElement | null;
  currentLocation: TerminalDockLocation | null;
  readyWritten: boolean;
  moveToEditor: (() => void) | null;
  moveToBottom: (() => void) | null;
} = {
  view: null,
  currentHost: null,
  currentLocation: null,
  readyWritten: false,
  moveToEditor: null,
  moveToBottom: null,
};
const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|Could not create web worker|MonacoEnvironment\.getWorker|MonacoEnvironment\.getWorkerUrl|worker_file|ts\.worker|json\.worker|Falling back to loading web worker code in main thread|Uncaught \[object Event\]|Uncaught Event/i;

const tabFixtures = {
  compose: createEditorTab("tab_compose", "src/compose.ts", "const 시작 = '한글';\n"),
  notes: createEditorTab("tab_notes", "src/notes.md", "# 노트\n\n한글 dock 이동 fixture\n"),
  side: createEditorTab("tab_side", "src/side.ts", "export const side = true;\n"),
} satisfies Record<string, EditorTab>;
const tabById = new Map<EditorTabId, EditorTab>(Object.values(tabFixtures).map((tab) => [tab.id, tab]));

installMonacoEnvironment();
installConsoleCapture();
initializeEditorGroups(editorGroupsService);
void runSmoke();

async function runSmoke(): Promise<void> {
  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);
    createRoot(rootElement).render(createElement(StrictMode, null, createElement(ImeDockPreservationFixture)));

    await waitForSelector('[data-fixture="ime-dock-preservation-runtime"]', 10_000);
    await waitForSelector('[data-editor-grid-provider="flexlayout-model"]', 10_000);
    await waitForSelector('[data-component="monaco-editor-host"][data-file-path="src/compose.ts"]', 10_000);
    await waitForMonacoTextarea("src/compose.ts", 10_000);
    await waitForSelector(".xterm-helper-textarea", 10_000);
    await settleFor(100);

    const scenarios: ScenarioResult[] = [];
    scenarios.push(await runMonacoDragTabScenario());
    scenarios.push(await runXtermDockMoveScenario());
    scenarios.push(await runXtermOverlayRebindAfterMoveScenario());
    scenarios.push(await runSplitterPointerMoveScenario());

    const latencySamples = await measureSyntheticCompositionPaintLatency();
    const latencyThresholdMs = latencyThresholdFromQuery();
    const latency = {
      sampleCount: latencySamples.length,
      samplesMs: latencySamples,
      p95Ms: percentile(latencySamples, 0.95),
      thresholdSource: "design.md" as const,
      thresholdMs: latencyThresholdMs,
      thresholdFound: latencyThresholdMs !== null,
    };

    const aggregate = {
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.passed).length,
      totalCompositionCancelCount: scenarios.reduce((sum, scenario) => sum + scenario.composition.cancelCount, 0),
      totalForcedFinishCount: scenarios.reduce((sum, scenario) => sum + scenario.composition.forcedFinishCount, 0),
      allSameCompositionSession: scenarios.every((scenario) => scenario.sameCompositionSession),
    };
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const latencyGatePassed = latencyThresholdMs === null || latency.p95Ms <= latencyThresholdMs;
    const ok =
      fatalErrors.length === 0 &&
      aggregate.scenarioCount === scenarios.length &&
      aggregate.passedScenarioCount === scenarios.length &&
      aggregate.totalCompositionCancelCount === 0 &&
      aggregate.totalForcedFinishCount === 0 &&
      aggregate.allSameCompositionSession &&
      latency.sampleCount >= 9 &&
      latencyGatePassed;

    publishResult({
      ok,
      errors: fatalErrors,
      scenarios,
      aggregate,
      latency,
      limitations: [
        "Electron synthetic CompositionEvent/PointerEvent dispatch cannot exercise the operating-system IME candidate window or native Monaco IME stack.",
        "This fixture is a deterministic event-spy guard: it fails on compositionend before the allowed finish, blur during composition, target unmount, session restart across dock/splitter operations, or an xterm IME overlay that stays bound to the old host after a terminal move.",
      ],
      reason:
        fatalErrors[0] ??
        scenarios.find((scenario) => !scenario.passed)?.reason ??
        (!latencyGatePassed
          ? `Synthetic composition p95 ${latency.p95Ms}ms exceeded design.md threshold ${latencyThresholdMs}ms.`
          : undefined),
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function ImeDockPreservationFixture(): JSX.Element {
  const model = useStore(editorGroupsService, (state) => state.model);
  const groups = useStore(editorGroupsService, (state) => state.groups);
  const activeGroupId = useStore(editorGroupsService, (state) => state.activeGroupId);
  const layoutSnapshot = useStore(editorGroupsService, (state) => state.layoutSnapshot);
  const [tabStateById, setTabStateById] = useState(() => new Map(tabById));
  const [bottomPanelSize, setBottomPanelSize] = useState(320);
  const [terminalLocation, setTerminalLocation] = useState<TerminalDockLocation>("bottom");
  const panes = useMemo(
    () => groups.map((group) => editorPaneFromGroup(group, tabStateById)),
    [groups, tabStateById],
  );
  const activePaneId = activeGroupId ?? groups[0]?.id ?? "group_left";

  useEffect(() => {
    terminalCompositionRuntime.moveToEditor = () => setTerminalLocation("editor");
    terminalCompositionRuntime.moveToBottom = () => setTerminalLocation("bottom");

    return () => {
      terminalCompositionRuntime.moveToEditor = null;
      terminalCompositionRuntime.moveToBottom = null;
    };
  }, []);

  const updateTabContent = (tabId: EditorTabId, content: string) => {
    setTabStateById((current) => {
      const next = new Map(current);
      const existing = next.get(tabId);
      if (existing) {
        next.set(tabId, {
          ...existing,
          content,
          dirty: content !== existing.savedContent,
          lspDocumentVersion: existing.lspDocumentVersion + 1,
        });
      }
      return next;
    });
  };

  const markTabSaved = (tabId: EditorTabId) => {
    setTabStateById((current) => {
      const next = new Map(current);
      const existing = next.get(tabId);
      if (existing) {
        next.set(tabId, {
          ...existing,
          savedContent: existing.content,
          dirty: false,
          saving: false,
        });
      }
      return next;
    });
  };

  return (
    <div data-fixture="ime-dock-preservation-runtime" className="h-screen min-h-0 bg-background text-foreground">
      <CenterWorkbench
        editorArea={
          <div className="relative h-full min-h-0 min-w-0">
            <EditorGroupsPart
              activeGroupId={activeGroupId}
              groups={groups}
              layoutSnapshot={layoutSnapshot}
              model={model}
              activeWorkspaceId={workspaceId}
              activeWorkspaceName="IME Dock Preservation"
              panes={panes}
              activePaneId={activePaneId}
              onActivatePane={(paneId) => editorGroupsService.getState().activateGroup(paneId)}
              onSplitRight={() => {
                const sourceGroupId = editorGroupsService.getState().activeGroupId ?? activePaneId;
                editorGroupsService.getState().splitGroup({ sourceGroupId, direction: "right", activate: true });
              }}
              onReorderTab={() => {
                // The runtime fixture exercises flexlayout drag/pointer and service move paths instead.
              }}
              onMoveTabToPane={(sourcePaneId, targetPaneId, tabId, targetIndex) => {
                editorGroupsService.getState().moveTab({
                  sourceGroupId: sourcePaneId,
                  targetGroupId: targetPaneId,
                  tabId,
                  targetIndex,
                  activate: true,
                });
              }}
              onSplitTabRight={(sourcePaneId, tabId) => {
                editorGroupsService.getState().splitGroup({ sourceGroupId: sourcePaneId, tabId, direction: "right" });
              }}
              onActivateTab={(paneId, tabId) => editorGroupsService.getState().activateTab(paneId, tabId)}
              onCloseTab={(paneId, tabId) => editorGroupsService.getState().closeTab(paneId, tabId)}
              onSaveTab={markTabSaved}
              onChangeContent={updateTabContent}
            />
            <div
              data-component="ime-dock-editor-terminal-target"
              data-active={terminalLocation === "editor" ? "true" : "false"}
              className={terminalLocation === "editor"
                ? "absolute bottom-4 right-4 z-20 h-56 w-[520px] rounded-md border border-ring bg-background shadow-xl"
                : "hidden"}
            >
              <TerminalCompositionSurface location="editor" active={terminalLocation === "editor"} />
            </div>
          </div>
        }
        bottomPanel={<TerminalCompositionSurface location="bottom" active={terminalLocation === "bottom"} />}
        bottomPanelPosition="bottom"
        bottomPanelExpanded
        bottomPanelSize={bottomPanelSize}
        activeArea="editor"
        onBottomPanelSizeChange={setBottomPanelSize}
      />
    </div>
  );
}

function TerminalCompositionSurface({
  location,
  active,
}: {
  location: TerminalDockLocation;
  active: boolean;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) {
      return;
    }

    attachTerminalCompositionView(host, location);

    return () => {
      if (terminalCompositionRuntime.currentHost === host) {
        terminalCompositionRuntime.view?.detach();
        terminalCompositionRuntime.currentHost = null;
        terminalCompositionRuntime.currentLocation = null;
      }
    };
  }, [active, location]);

  return (
    <section
      data-component="ime-dock-terminal-surface"
      data-terminal-location={location}
      data-active={active ? "true" : "false"}
      className="flex h-full min-h-0 flex-col bg-background p-2"
    >
      <div
        ref={hostRef}
        data-component="ime-dock-xterm-host"
        data-terminal-location={location}
        className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background"
      />
    </section>
  );
}

function attachTerminalCompositionView(host: HTMLElement, location: TerminalDockLocation): void {
  const view = ensureTerminalCompositionView();
  if (terminalCompositionRuntime.currentHost !== host) {
    terminalCompositionRuntime.view?.detach();
    view.mount(host);
    terminalCompositionRuntime.currentHost = host;
    terminalCompositionRuntime.currentLocation = location;
  } else {
    view.fit();
  }

  if (!terminalCompositionRuntime.readyWritten) {
    view.write("IME dock preservation terminal ready\r\n");
    terminalCompositionRuntime.readyWritten = true;
  }
}

function ensureTerminalCompositionView(): XtermView {
  if (terminalCompositionRuntime.view) {
    return terminalCompositionRuntime.view;
  }

  terminalCompositionRuntime.view = new XtermView({
    terminalOptions: {
      rows: 12,
      cols: 80,
      convertEol: true,
    },
    getImeCursorAnchor: () => ({ x: 18, y: 24, height: 20 }),
    onInput(data) {
      terminalInputs.push(data);
    },
  });
  return terminalCompositionRuntime.view;
}

async function runMonacoDragTabScenario(): Promise<ScenarioResult> {
  const name: ScenarioName = "monaco-editor-drag-tab-cycle";
  const operationLog: string[] = [];
  const target = await waitForMonacoTextarea("src/compose.ts", 5_000);
  const spy = new CompositionSessionSpy(name, target, "monaco");

  try {
    spy.start("ㅎ");
    operationLog.push("compositionstart:ㅎ");
    await recordLatencySample(target, "하");
    spy.update("하");
    operationLog.push("compositionupdate:하");

    const tabElement = findTabElementByTitle("compose.ts");
    if (!tabElement) {
      return spy.finishScenario(false, operationLog, "Could not find a production flexlayout/editor tab element for compose.ts.");
    }

    await simulatePointerDrag(tabElement, operationLog, "drag-tab-cycle");
    await settleFor(100);

    spy.allowExpectedEnd();
    spy.end("한");
    operationLog.push("compositionend:한");
    return spy.finishScenario(true, operationLog);
  } finally {
    spy.dispose();
  }
}

async function runXtermDockMoveScenario(): Promise<ScenarioResult> {
  const name: ScenarioName = "xterm-korean-input-around-dock-move";
  const operationLog: string[] = [];
  const target = await waitForSelector<HTMLTextAreaElement>(".xterm-helper-textarea", 5_000);
  const spy = new CompositionSessionSpy(name, target, "xterm");

  try {
    const inputsBefore = terminalInputs.length;
    spy.start("ㅎ");
    operationLog.push("xterm-compositionstart:ㅎ");
    spy.update("한글");
    operationLog.push("xterm-compositionupdate:한글");

    const beforeSignature = collectGridSignature();
    editorGroupsService.getState().moveTab({
      sourceGroupId: "group_left",
      targetGroupId: "group_right",
      tabId: tabFixtures.notes.id,
      activate: false,
    });
    await settleFor(150);
    const afterSignature = collectGridSignature();
    operationLog.push(`dock-move-notes:before=${beforeSignature}:after=${afterSignature}`);

    spy.allowExpectedEnd();
    spy.end("한글");
    await settleFor(50);
    operationLog.push(`terminal-inputs:${terminalInputs.slice(inputsBefore).join("|")}`);

    const committedToXterm = terminalInputs.slice(inputsBefore).includes("한글");
    return spy.finishScenario(
      committedToXterm,
      operationLog,
      committedToXterm ? undefined : "xterm compositionend did not commit the Korean text through XtermView.onInput.",
    );
  } finally {
    spy.dispose();
  }
}

async function runXtermOverlayRebindAfterMoveScenario(): Promise<ScenarioResult> {
  const name: ScenarioName = "xterm-ime-overlay-rebind-after-terminal-move";
  const operationLog: string[] = [];
  const beforeTarget = await waitForSelector<HTMLTextAreaElement>(".xterm-helper-textarea", 5_000);
  const beforeHost = beforeTarget.closest<HTMLElement>('[data-component="ime-dock-xterm-host"]');
  const beforeLocation = beforeHost?.dataset.terminalLocation ?? "unknown";
  const beforeOverlayCount = beforeHost?.querySelectorAll(`.${XTERM_IME_OVERLAY_CLASS}`).length ?? 0;

  if (!terminalCompositionRuntime.moveToEditor) {
    throw new Error("Terminal composition runtime did not expose a moveToEditor hook.");
  }

  terminalCompositionRuntime.moveToEditor();
  operationLog.push(`terminal-move:from=${beforeLocation}:to=editor`);
  await waitUntil(
    () => terminalCompositionRuntime.currentLocation === "editor" &&
      document.querySelector('[data-component="ime-dock-xterm-host"][data-terminal-location="editor"] .xterm-helper-textarea'),
    5_000,
    () => `Timed out waiting for xterm helper textarea to rebind in editor host; currentLocation=${terminalCompositionRuntime.currentLocation ?? "null"}.`,
  );
  await settleFor(100);

  const target = await waitForSelector<HTMLTextAreaElement>(
    '[data-component="ime-dock-xterm-host"][data-terminal-location="editor"] .xterm-helper-textarea',
    5_000,
  );
  const spy = new CompositionSessionSpy(name, target, "xterm");

  try {
    const inputsBefore = terminalInputs.length;
    const editorHost = target.closest<HTMLElement>('[data-component="ime-dock-xterm-host"][data-terminal-location="editor"]');
    const sameHelperTextareaAfterMove = target === beforeTarget;
    const beforeOverlayStillInBottom = beforeHost?.querySelectorAll(`.${XTERM_IME_OVERLAY_CLASS}`).length ?? 0;

    spy.start("ㅎ");
    operationLog.push("rebound-xterm-compositionstart:ㅎ");
    spy.update("한");
    operationLog.push("rebound-xterm-compositionupdate:한");
    await animationFrame();

    const overlay = editorHost?.querySelector<HTMLElement>(`.${XTERM_IME_OVERLAY_CLASS}`) ?? null;
    const overlayReboundToEditorHost =
      Boolean(editorHost) &&
      Boolean(overlay) &&
      overlay?.textContent === "한" &&
      overlay?.style.visibility === "visible" &&
      !beforeHost?.contains(overlay);
    operationLog.push(
      `overlay:beforeCount=${beforeOverlayCount}:bottomAfterMove=${beforeOverlayStillInBottom}:editorVisible=${overlay?.style.visibility ?? "missing"}:sameTextarea=${sameHelperTextareaAfterMove}`,
    );

    spy.allowExpectedEnd();
    spy.end("한");
    await settleFor(50);
    const committedToXterm = terminalInputs.slice(inputsBefore).includes("한");
    operationLog.push(`terminal-inputs:${terminalInputs.slice(inputsBefore).join("|")}`);

    const operationPassed = sameHelperTextareaAfterMove && overlayReboundToEditorHost && committedToXterm;
    return spy.finishScenario(
      operationPassed,
      operationLog,
      operationPassed
        ? undefined
        : `Expected same xterm helper textarea to move to editor and IME overlay to rebind/commit; sameTextarea=${sameHelperTextareaAfterMove}, overlayRebound=${overlayReboundToEditorHost}, committed=${committedToXterm}.`,
    );
  } finally {
    spy.dispose();
  }
}

async function runSplitterPointerMoveScenario(): Promise<ScenarioResult> {
  const name: ScenarioName = "splitter-pointermove-during-composition";
  const operationLog: string[] = [];
  const target = await waitForMonacoTextarea("src/compose.ts", 5_000);
  const spy = new CompositionSessionSpy(name, target, "monaco");

  try {
    spy.start("ㄱ");
    operationLog.push("compositionstart:ㄱ");
    spy.update("가");
    operationLog.push("compositionupdate:가");

    const resizeHandle = await waitForSelector<HTMLElement>('[role="separator"][aria-label="Resize bottom panel"]', 5_000);
    await simulatePointerDrag(resizeHandle, operationLog, "bottom-panel-splitter");
    await settleFor(100);

    spy.allowExpectedEnd();
    spy.end("가");
    operationLog.push("compositionend:가");
    return spy.finishScenario(true, operationLog);
  } finally {
    spy.dispose();
  }
}

class CompositionSessionSpy {
  private starts = 0;
  private updates = 0;
  private ends = 0;
  private forcedFinishCount = 0;
  private blurWhileComposingCount = 0;
  private unmountDuringCompositionCount = 0;
  private compositionCancelEventCount = 0;
  private activeSessionId: number | null = null;
  private startSessionId: number | null = null;
  private endSessionId: number | null = null;
  private composing = false;
  private expectedEndAllowed = false;
  private finalCommittedText: string | null = null;
  private readonly observer: MutationObserver;
  private readonly removers: Array<() => void> = [];

  public constructor(
    private readonly scenarioName: ScenarioName,
    private readonly target: HTMLElement,
    private readonly targetKind: TargetKind,
  ) {
    this.observer = new MutationObserver(() => {
      if (this.composing && !this.target.isConnected) {
        this.unmountDuringCompositionCount += 1;
      }
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.installListeners();
  }

  public start(data: string): void {
    this.target.focus?.({ preventScroll: true });
    dispatchCompositionEvent(this.target, "compositionstart", data);
  }

  public update(data: string): void {
    dispatchCompositionEvent(this.target, "compositionupdate", data);
  }

  public allowExpectedEnd(): void {
    this.expectedEndAllowed = true;
  }

  public end(data: string): void {
    dispatchCompositionEvent(this.target, "compositionend", data);
  }

  public finishScenario(operationPassed: boolean, operationLog: string[], operationFailure?: string): ScenarioResult {
    const composition = this.summary();
    const sameCompositionSession =
      composition.starts === 1 &&
      composition.ends === 1 &&
      composition.startSessionId !== null &&
      composition.startSessionId === composition.endSessionId;
    const passed =
      operationPassed &&
      sameCompositionSession &&
      composition.cancelCount === 0 &&
      composition.forcedFinishCount === 0 &&
      composition.targetConnectedAtEnd;

    return {
      name: this.scenarioName,
      passed,
      targetKind: this.targetKind,
      sameCompositionSession,
      composition,
      operationLog,
      reason:
        operationFailure ??
        (!sameCompositionSession ? `Expected one composition session from start to end, saw ${JSON.stringify(composition)}.` : undefined) ??
        (composition.cancelCount !== 0 ? `Composition cancel count was ${composition.cancelCount}.` : undefined) ??
        (composition.forcedFinishCount !== 0 ? `Composition forced finish count was ${composition.forcedFinishCount}.` : undefined) ??
        (!composition.targetConnectedAtEnd ? "Composition target was unmounted by the dock/splitter operation." : undefined),
    };
  }

  public dispose(): void {
    for (const remove of this.removers) {
      remove();
    }
    this.removers.length = 0;
    this.observer.disconnect();
  }

  private installListeners(): void {
    this.addListener("compositionstart", () => {
      this.starts += 1;
      if (this.composing) {
        this.forcedFinishCount += 1;
      }
      this.composing = true;
      this.expectedEndAllowed = false;
      this.activeSessionId = this.starts;
      this.startSessionId = this.activeSessionId;
    });
    this.addListener("compositionupdate", () => {
      if (!this.composing) {
        this.forcedFinishCount += 1;
      }
      this.updates += 1;
    });
    this.addListener("compositionend", (event) => {
      this.ends += 1;
      this.endSessionId = this.activeSessionId;
      this.finalCommittedText = event instanceof CompositionEvent ? event.data : readEventData(event);
      if (!this.expectedEndAllowed) {
        this.forcedFinishCount += 1;
      }
      this.composing = false;
      this.activeSessionId = null;
      this.expectedEndAllowed = false;
    });
    this.addListener("compositioncancel", () => {
      this.compositionCancelEventCount += 1;
      this.composing = false;
      this.activeSessionId = null;
    });
    this.addListener("blur", () => {
      if (this.composing) {
        this.blurWhileComposingCount += 1;
      }
    });
  }

  private addListener(type: string, listener: EventListener): void {
    this.target.addEventListener(type, listener);
    this.removers.push(() => this.target.removeEventListener(type, listener));
  }

  private summary(): CompositionSpySummary {
    return {
      starts: this.starts,
      updates: this.updates,
      ends: this.ends,
      cancelCount: this.blurWhileComposingCount + this.unmountDuringCompositionCount + this.compositionCancelEventCount,
      forcedFinishCount: this.forcedFinishCount,
      blurWhileComposingCount: this.blurWhileComposingCount,
      unmountDuringCompositionCount: this.unmountDuringCompositionCount,
      startSessionId: this.startSessionId,
      endSessionId: this.endSessionId,
      finalCommittedText: this.finalCommittedText,
      targetConnectedAtEnd: this.target.isConnected,
    };
  }
}

function initializeEditorGroups(service: EditorGroupsServiceStore): void {
  service.getState().setGroups([
    {
      id: "group_left",
      tabs: [groupTabFromEditorTab(tabFixtures.compose), groupTabFromEditorTab(tabFixtures.notes)],
      activeTabId: tabFixtures.compose.id,
    },
    {
      id: "group_right",
      tabs: [groupTabFromEditorTab(tabFixtures.side)],
      activeTabId: tabFixtures.side.id,
    },
  ], "group_left");
}

function editorPaneFromGroup(group: EditorGroup, tabStateById: ReadonlyMap<EditorTabId, EditorTab>): EditorPaneState {
  return {
    id: group.id,
    activeTabId: group.activeTabId,
    tabs: group.tabs
      .map((tab) => tabStateById.get(tab.id) ?? editorTabFromGroupTab(tab))
      .filter((tab): tab is EditorTab => tab !== null),
  };
}

function createEditorTab(id: EditorTabId, filePath: string, content: string): EditorTab {
  const language = null;
  return {
    kind: "file",
    id,
    workspaceId,
    path: filePath,
    title: filePath.split("/").at(-1) ?? filePath,
    content,
    savedContent: content,
    version: "fixture-v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language,
    monacoLanguage: monacoLanguageIdForPath(filePath, language),
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
  };
}

function groupTabFromEditorTab(tab: EditorTab): EditorGroupTab {
  return {
    id: tab.id,
    title: tab.title,
    kind: "file",
    workspaceId: tab.workspaceId,
    resourcePath: tab.path,
  };
}

function editorTabFromGroupTab(tab: EditorGroupTab): EditorTab | null {
  if (!tab.resourcePath || !tab.workspaceId) {
    return null;
  }
  return createEditorTab(tab.id, tab.resourcePath, "");
}

function findTabElementByTitle(title: string): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(".flexlayout__tab_button, [data-action='editor-activate-tab']"),
  );
  return candidates.find((candidate) => candidate.textContent?.includes(title) === true) ?? null;
}

async function simulatePointerDrag(element: HTMLElement, operationLog: string[], label: string): Promise<void> {
  const rect = element.getBoundingClientRect();
  const pointerId = label === "bottom-panel-splitter" ? 77 : 33;
  const startX = rect.left + Math.max(4, Math.min(rect.width / 2, 12));
  const startY = rect.top + Math.max(4, Math.min(rect.height / 2, 12));
  const init = { pointerId, clientX: startX, clientY: startY, buttons: 1 };

  element.dispatchEvent(createPointerEvent("pointerdown", init));
  operationLog.push(`${label}:pointerdown`);
  await animationFrame();

  window.dispatchEvent(createPointerEvent("pointermove", {
    pointerId,
    clientX: startX + 48,
    clientY: startY + (label === "bottom-panel-splitter" ? -24 : 24),
    buttons: 1,
  }));
  document.dispatchEvent(createPointerEvent("pointermove", {
    pointerId,
    clientX: startX + 48,
    clientY: startY + (label === "bottom-panel-splitter" ? -24 : 24),
    buttons: 1,
  }));
  operationLog.push(`${label}:pointermove`);
  await animationFrame();

  window.dispatchEvent(createPointerEvent("pointerup", {
    pointerId,
    clientX: startX + 48,
    clientY: startY + (label === "bottom-panel-splitter" ? -24 : 24),
    buttons: 0,
  }));
  document.dispatchEvent(createPointerEvent("pointerup", {
    pointerId,
    clientX: startX + 48,
    clientY: startY + (label === "bottom-panel-splitter" ? -24 : 24),
    buttons: 0,
  }));
  operationLog.push(`${label}:pointerup`);
  await animationFrame();
}

function createPointerEvent(type: string, init: PointerLikeInit): Event {
  if (typeof PointerEvent !== "undefined") {
    return new PointerEvent(type, {
      pointerId: init.pointerId,
      clientX: init.clientX,
      clientY: init.clientY,
      buttons: init.buttons ?? 0,
      pointerType: "mouse",
      bubbles: true,
      cancelable: true,
    });
  }
  return new MouseEvent(type, {
    clientX: init.clientX,
    clientY: init.clientY,
    buttons: init.buttons ?? 0,
    bubbles: true,
    cancelable: true,
  });
}

async function measureSyntheticCompositionPaintLatency(): Promise<number[]> {
  const monacoTarget = await waitForMonacoTextarea("src/compose.ts", 5_000);
  const xtermTarget = await waitForSelector<HTMLTextAreaElement>(".xterm-helper-textarea", 5_000);
  const samples: number[] = [];
  for (const target of [monacoTarget, xtermTarget]) {
    for (const text of ["ㅎ", "하", "한", "한ㄱ", "한그", "한글"]) {
      samples.push(await recordLatencySample(target, text));
    }
  }
  return samples;
}

async function recordLatencySample(target: HTMLElement, data: string): Promise<number> {
  const startedAt = performance.now();
  dispatchCompositionEvent(target, "compositionupdate", data);
  await animationFrame();
  return roundLatency(performance.now() - startedAt);
}

function dispatchCompositionEvent(target: HTMLElement, type: string, data: string): void {
  if (typeof CompositionEvent !== "undefined") {
    target.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, cancelable: true }));
    return;
  }
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { data?: string };
  event.data = data;
  target.dispatchEvent(event);
}

async function waitForMonacoTextarea(filePath: string, timeoutMs: number): Promise<HTMLTextAreaElement> {
  return waitUntil(
    () => {
      const host = document.querySelector<HTMLElement>(
        `[data-component="monaco-editor-host"][data-file-path="${CSS.escape(filePath)}"]`,
      );
      return host?.querySelector<HTMLTextAreaElement>("textarea.inputarea, textarea") ?? null;
    },
    timeoutMs,
    () => `Timed out waiting for Monaco textarea for ${filePath}.`,
  );
}

async function waitForSelector<TElement extends HTMLElement = HTMLElement>(
  selector: string,
  timeoutMs: number,
): Promise<TElement> {
  return waitUntil(
    () => document.querySelector<TElement>(selector),
    timeoutMs,
    () => `Timed out waiting for selector ${selector}.`,
  );
}

async function waitUntil<T>(
  probe: () => T | null | undefined | false,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<NonNullable<T>> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const value = probe();
    if (value) {
      return value as NonNullable<T>;
    }
    await settleFor(50);
  }
  throw new Error(describeFailure());
}

function collectGridSignature(): string {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-editor-grid-slot]"))
    .map((slot) => [
      slot.dataset.editorGridSlot ?? "",
      slot.dataset.editorGroupId ?? "",
      slot.dataset.editorGroupTabCount ?? "0",
      slot.dataset.editorGroupActiveTabId ?? "",
    ].join(":"))
    .join("|");
}

function latencyThresholdFromQuery(): number | null {
  const raw = new URL(window.location.href).searchParams.get("designP95ThresholdMs");
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return roundLatency(sorted[index] ?? 0);
}

function roundLatency(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function readEventData(event: Event): string | null {
  const candidate = event as Event & { data?: unknown };
  return typeof candidate.data === "string" ? candidate.data : null;
}

function prepareDocument(rootElement: HTMLElement): void {
  rootElement.innerHTML = "";
  rootElement.style.height = "100vh";
  document.documentElement.style.height = "100%";
  document.body.style.height = "100%";
  document.body.style.margin = "0";
}

function installConsoleCapture(): void {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    capturedErrors.push(args.map(stringifyErrorPart).join(" "));
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    capturedErrors.push(args.map(stringifyErrorPart).join(" "));
    originalWarn(...args);
  };
  window.addEventListener("error", (event) => {
    capturedErrors.push(stringifyErrorPart(event.error ?? event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    capturedErrors.push(stringifyErrorPart(event.reason));
  });
}

function failedResult(reason: string): ImeDockPreservationRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    scenarios: [],
    aggregate: {
      scenarioCount: 0,
      passedScenarioCount: 0,
      totalCompositionCancelCount: 0,
      totalForcedFinishCount: 0,
      allSameCompositionSession: false,
    },
    latency: {
      sampleCount: 0,
      samplesMs: [],
      p95Ms: 0,
      thresholdSource: "design.md",
      thresholdMs: latencyThresholdFromQuery(),
      thresholdFound: latencyThresholdFromQuery() !== null,
    },
    limitations: [],
    reason,
  };
}

function publishResult(result: ImeDockPreservationRuntimeSmokeResult): void {
  window.__nexusImeDockPreservationRuntimeSmokeResult = result;
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

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function settleFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
