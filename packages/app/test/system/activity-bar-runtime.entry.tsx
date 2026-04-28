import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useStore } from "zustand";

import "../../src/renderer/styles.css";
import { ActivityBarPart } from "../../src/renderer/parts/activity-bar";
import { SideBarPart } from "../../src/renderer/parts/side-bar";
import {
  DEFAULT_SIDE_BAR_WIDTH,
  createActivityBarService,
  type ActivityBarServiceStore,
  type ActivityBarViewId,
} from "../../src/renderer/services/activity-bar-service";

type DefaultViewId = "explorer" | "search" | "source-control" | "tool" | "session" | "preview";

interface ExpectedView {
  id: DefaultViewId;
  label: string;
  stubText: string;
}

interface ActivityBarRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  expectedViewIds: string[];
  exposedViews: Array<{
    id: string;
    label: string;
    active: boolean;
  }>;
  exposedViewCount: number;
  clickTransitions: Array<{
    viewId: string;
    expectedLabel: string;
    activeContentId: string;
    contentText: string;
    matched: boolean;
  }>;
  collapseExpand: {
    cycles: number;
    toggleCount: number;
    states: Array<{
      cycle: number;
      phase: "collapsed" | "expanded";
      sideBarCollapsed: boolean;
      sideBarVisible: boolean;
      activityBarAttr: string;
      activeContentId: string | null;
    }>;
    finalCollapsed: boolean;
  };
  strictMode: {
    iterations: number;
    leakSignals: string[];
    leakSignalCount: number;
  };
  reason?: string;
}

declare global {
  interface Window {
    __nexusActivityBarRuntimeSmokeResult?: ActivityBarRuntimeSmokeResult;
  }
}

const EXPECTED_VIEWS: ExpectedView[] = [
  { id: "explorer", label: "Explorer", stubText: "Explorer fixture content" },
  { id: "search", label: "Search", stubText: "Search fixture content" },
  { id: "source-control", label: "Source Control", stubText: "Source Control fixture content" },
  { id: "tool", label: "Tool", stubText: "Tool fixture content" },
  { id: "session", label: "Session", stubText: "Session fixture content" },
  { id: "preview", label: "Preview", stubText: "Preview fixture content" },
];
const COLLAPSE_EXPAND_CYCLES = 5;
const STRICT_MODE_ITERATIONS = 5;
const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act/i;
const capturedErrors: string[] = [];
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

console.error = (...args: unknown[]) => {
  capturedErrors.push(args.map(stringifyErrorPart).join(" "));
  originalConsoleError(...args);
};
console.warn = (...args: unknown[]) => {
  const message = args.map(stringifyErrorPart).join(" ");
  if (suspiciousMessagePattern.test(message)) {
    capturedErrors.push(message);
  }
  originalConsoleWarn(...args);
};
window.addEventListener("error", (event) => {
  capturedErrors.push(stringifyErrorPart(event.error ?? event.message));
});
window.addEventListener("unhandledrejection", (event) => {
  capturedErrors.push(stringifyErrorPart(event.reason));
});

void runSmoke();

async function runSmoke(): Promise<void> {
  const store = createActivityBarService();
  const keydownAbortController = new AbortController();

  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);
    installSideBarToggleKeybinding(store, keydownAbortController.signal);

    const root = createRoot(rootElement);
    root.render(
      <StrictMode>
        <ActivityBarRuntimeHarness store={store} />
      </StrictMode>,
    );
    await waitForSelector('[data-component="activity-bar"]', rootElement, 5_000);

    const exposedViews = collectExposedViews();
    const clickTransitions = [] as ActivityBarRuntimeSmokeResult["clickTransitions"];
    for (const expectedView of EXPECTED_VIEWS) {
      const button = activityViewButton(expectedView.id);
      if (!button) {
        clickTransitions.push({
          viewId: expectedView.id,
          expectedLabel: expectedView.label,
          activeContentId: "missing-button",
          contentText: "",
          matched: false,
        });
        continue;
      }

      button.click();
      await waitForSideBarContent(expectedView.id);
      const activeSideBar = document.querySelector<HTMLElement>('[data-component="side-bar"]');
      const content = document.querySelector<HTMLElement>(`[data-sidebar-stub="${expectedView.id}"]`);
      clickTransitions.push({
        viewId: expectedView.id,
        expectedLabel: expectedView.label,
        activeContentId: activeSideBar?.dataset.activeContentId ?? "missing-side-bar",
        contentText: content?.textContent?.trim() ?? "",
        matched:
          activeSideBar?.dataset.activeContentId === expectedView.id &&
          content?.textContent?.includes(expectedView.stubText) === true,
      });
    }

    const collapseExpand = await exerciseCollapseExpandCycles(store);
    root.unmount();
    await animationFrame();

    const strictMode = await runStrictModeMountStableProbe(rootElement);
    keydownAbortController.abort();

    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const expectedViewIds = EXPECTED_VIEWS.map((view) => view.id);
    const exposedViewIds = exposedViews.map((view) => view.id);
    const exposedLabels = exposedViews.map((view) => view.label);
    const allViewsExposed =
      exposedViews.length === EXPECTED_VIEWS.length &&
      EXPECTED_VIEWS.every((view) => exposedViewIds.includes(view.id) && exposedLabels.includes(view.label));
    const allClicksMatched = clickTransitions.every((transition) => transition.matched);
    const allCollapseStatesMatched =
      collapseExpand.cycles === COLLAPSE_EXPAND_CYCLES &&
      collapseExpand.toggleCount === COLLAPSE_EXPAND_CYCLES * 2 &&
      collapseExpand.states.every((state) =>
        state.phase === "collapsed"
          ? state.sideBarCollapsed && !state.sideBarVisible && state.activityBarAttr === "true"
          : !state.sideBarCollapsed && state.sideBarVisible && state.activityBarAttr === "false"
      );

    publishResult({
      ok:
        fatalErrors.length === 0 &&
        allViewsExposed &&
        allClicksMatched &&
        allCollapseStatesMatched &&
        strictMode.iterations === STRICT_MODE_ITERATIONS &&
        strictMode.leakSignalCount === 0,
      errors: fatalErrors,
      expectedViewIds,
      exposedViews,
      exposedViewCount: exposedViews.length,
      clickTransitions,
      collapseExpand,
      strictMode,
      reason:
        fatalErrors[0] ??
        (!allViewsExposed
          ? `Expected Activity Bar views ${expectedViewIds.join(",")}, saw ${exposedViewIds.join(",")}`
          : undefined) ??
        (!allClicksMatched
          ? `Activity Bar click transition failed: ${JSON.stringify(clickTransitions.find((transition) => !transition.matched))}`
          : undefined) ??
        (!allCollapseStatesMatched
          ? `Collapse/expand cycle failed: ${JSON.stringify(collapseExpand.states.find((state) => state.phase === "collapsed" ? !state.sideBarCollapsed || state.sideBarVisible : state.sideBarCollapsed || !state.sideBarVisible))}`
          : undefined) ??
        (strictMode.leakSignalCount > 0 ? strictMode.leakSignals[0] : undefined),
    });
  } catch (error) {
    keydownAbortController.abort();
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function ActivityBarRuntimeHarness({ store }: { store: ActivityBarServiceStore }): JSX.Element {
  const views = useStore(store, (state) => state.views);
  const activeViewId = useStore(store, (state) => state.activeViewId);
  const sideBarCollapsed = useStore(store, (state) => state.sideBarCollapsed);
  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  const route = activeView
    ? { title: activeView.sideBarTitle, contentId: activeView.sideBarContentId }
    : null;

  return (
    <div data-fixture="activity-bar-runtime" className="flex h-full min-h-0 bg-background text-foreground">
      <ActivityBarPart
        views={views}
        activeViewId={activeViewId}
        sideBarCollapsed={sideBarCollapsed}
        onActiveViewChange={(viewId) => {
          store.getState().setActiveView(viewId);
          store.getState().setSideBarCollapsed(false);
        }}
      />
      {!sideBarCollapsed && (
        <div
          data-panel="side-bar"
          className="min-h-0 shrink-0 overflow-hidden"
          style={{ flexBasis: DEFAULT_SIDE_BAR_WIDTH, width: DEFAULT_SIDE_BAR_WIDTH }}
        >
          <SideBarPart
            route={route}
            explorer={<FixtureSideBarStub viewId="explorer" />}
            search={<FixtureSideBarStub viewId="search" />}
            sourceControl={<FixtureSideBarStub viewId="source-control" />}
            tool={<FixtureSideBarStub viewId="tool" />}
            session={<FixtureSideBarStub viewId="session" />}
            preview={<FixtureSideBarStub viewId="preview" />}
          />
        </div>
      )}
      <main data-panel="center" className="min-h-0 min-w-0 flex-1 p-4">
        <h1 className="text-sm font-medium">Activity Bar runtime fixture center</h1>
      </main>
    </div>
  );
}

function FixtureSideBarStub({ viewId }: { viewId: DefaultViewId }): JSX.Element {
  const expectedView = EXPECTED_VIEWS.find((view) => view.id === viewId);

  return (
    <section data-sidebar-stub={viewId} className="p-3 text-sm">
      <h3>{expectedView?.label}</h3>
      <p>{expectedView?.stubText}</p>
    </section>
  );
}

function installSideBarToggleKeybinding(store: ActivityBarServiceStore, signal: AbortSignal): void {
  window.addEventListener(
    "keydown",
    (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        store.getState().toggleSideBar();
      }
    },
    { signal },
  );
}

async function exerciseCollapseExpandCycles(
  store: ActivityBarServiceStore,
): Promise<ActivityBarRuntimeSmokeResult["collapseExpand"]> {
  const states: ActivityBarRuntimeSmokeResult["collapseExpand"]["states"] = [];

  if (store.getState().sideBarCollapsed) {
    dispatchCmdB();
    await waitForSideBarExpanded();
  }

  for (let cycle = 1; cycle <= COLLAPSE_EXPAND_CYCLES; cycle += 1) {
    dispatchCmdB();
    await waitForSideBarCollapsed();
    states.push(collectCollapseState(cycle, "collapsed"));

    dispatchCmdB();
    await waitForSideBarExpanded();
    states.push(collectCollapseState(cycle, "expanded"));
  }

  return {
    cycles: COLLAPSE_EXPAND_CYCLES,
    toggleCount: states.length,
    states,
    finalCollapsed: store.getState().sideBarCollapsed,
  };
}

async function runStrictModeMountStableProbe(
  rootElement: HTMLElement,
): Promise<ActivityBarRuntimeSmokeResult["strictMode"]> {
  const leakSignals: string[] = [];

  for (let iteration = 0; iteration < STRICT_MODE_ITERATIONS; iteration += 1) {
    rootElement.replaceChildren();
    const mount = document.createElement("div");
    mount.dataset.strictModeIteration = String(iteration + 1);
    mount.style.width = "100%";
    mount.style.height = "100%";
    rootElement.append(mount);

    const store = createActivityBarService({ activeViewId: "tool" });
    let root: Root | null = createRoot(mount);
    root.render(
      <StrictMode>
        <ActivityBarRuntimeHarness store={store} />
      </StrictMode>,
    );
    await waitForSelector('[data-component="activity-bar"]', mount, 5_000);

    store.getState().toggleSideBar();
    await waitForSideBarCollapsed(mount);
    store.getState().toggleSideBar();
    await waitForSideBarExpanded(mount);

    root.unmount();
    root = null;
    await animationFrame();
    await animationFrame();

    if (mount.querySelector('[data-component="activity-bar"], [data-component="side-bar"], [data-sidebar-stub]')) {
      leakSignals.push(`Iteration ${iteration + 1} left Activity Bar or Side Bar DOM after unmount.`);
    }
    mount.remove();
    await animationFrame();
  }

  return {
    iterations: STRICT_MODE_ITERATIONS,
    leakSignals,
    leakSignalCount: leakSignals.length,
  };
}

function collectExposedViews(): ActivityBarRuntimeSmokeResult["exposedViews"] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-activity-view]")).map((button) => ({
    id: button.dataset.activityView ?? "",
    label: button.getAttribute("aria-label") ?? "",
    active: button.dataset.active === "true",
  }));
}

function collectCollapseState(
  cycle: number,
  phase: "collapsed" | "expanded",
): ActivityBarRuntimeSmokeResult["collapseExpand"]["states"][number] {
  const activityBar = document.querySelector<HTMLElement>('[data-component="activity-bar"]');
  const sideBar = document.querySelector<HTMLElement>('[data-component="side-bar"]');

  return {
    cycle,
    phase,
    sideBarCollapsed: activityBar?.dataset.sideBarCollapsed === "true",
    sideBarVisible: sideBar !== null,
    activityBarAttr: activityBar?.dataset.sideBarCollapsed ?? "missing",
    activeContentId: sideBar?.dataset.activeContentId ?? null,
  };
}

function dispatchCmdB(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyB",
      key: "b",
      metaKey: true,
    }),
  );
}

function activityViewButton(viewId: ActivityBarViewId): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-activity-view]"))
    .find((button) => button.dataset.activityView === viewId) ?? null;
}

async function waitForSideBarContent(viewId: DefaultViewId): Promise<void> {
  await waitUntil(() => {
    const sideBar = document.querySelector<HTMLElement>('[data-component="side-bar"]');
    const content = document.querySelector<HTMLElement>(`[data-sidebar-stub="${viewId}"]`);
    return sideBar?.dataset.activeContentId === viewId && content !== null;
  }, 5_000, () => `Timed out waiting for Side Bar content ${viewId}`);
}

async function waitForSideBarCollapsed(root: ParentNode = document): Promise<void> {
  await waitUntil(() => {
    const activityBar = root.querySelector<HTMLElement>('[data-component="activity-bar"]');
    const sideBar = root.querySelector<HTMLElement>('[data-component="side-bar"]');
    return activityBar?.dataset.sideBarCollapsed === "true" && sideBar === null;
  }, 5_000, () => "Timed out waiting for Side Bar to collapse");
}

async function waitForSideBarExpanded(root: ParentNode = document): Promise<void> {
  await waitUntil(() => {
    const activityBar = root.querySelector<HTMLElement>('[data-component="activity-bar"]');
    const sideBar = root.querySelector<HTMLElement>('[data-component="side-bar"]');
    return activityBar?.dataset.sideBarCollapsed === "false" && sideBar !== null;
  }, 5_000, () => "Timed out waiting for Side Bar to expand");
}

async function waitForSelector(selector: string, root: ParentNode = document, timeoutMs = 5_000): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await waitUntil(() => {
    element = root.querySelector<HTMLElement>(selector);
    return element !== null;
  }, timeoutMs, () => `Timed out waiting for selector ${selector}`);

  return element;
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

function prepareDocument(rootElement: HTMLElement): void {
  document.documentElement.style.width = "1200px";
  document.documentElement.style.height = "760px";
  document.body.style.width = "1200px";
  document.body.style.height = "760px";
  document.body.style.margin = "0";
  rootElement.style.width = "1200px";
  rootElement.style.height = "760px";
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function failedResult(reason: string): ActivityBarRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    expectedViewIds: EXPECTED_VIEWS.map((view) => view.id),
    exposedViews: [],
    exposedViewCount: 0,
    clickTransitions: [],
    collapseExpand: {
      cycles: 0,
      toggleCount: 0,
      states: [],
      finalCollapsed: false,
    },
    strictMode: {
      iterations: 0,
      leakSignals: [],
      leakSignalCount: 0,
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

function publishResult(result: ActivityBarRuntimeSmokeResult): void {
  window.__nexusActivityBarRuntimeSmokeResult = result;
}
