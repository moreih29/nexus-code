import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import "../../src/renderer/styles.css";
import "../../src/renderer/parts/editor-groups/flexlayout-theme.css";
import {
  FLEX_LAYOUT_SPIKE_MAX_PANES,
  FLEX_LAYOUT_STRICT_MODE_SMOKE_ITERATIONS,
  FlexLayoutSpike,
  collectDropOverlayDirections,
  countSpikeModelPanes,
  createFourPaneSpikeModel,
  createSixSplitSpikeModel,
  expandFourPaneModelToSixSplits,
  hasRequiredDropOverlayDirections,
  probeFloatingPanelCapability,
  probeSplitterSymmetry,
} from "../../src/renderer/parts/editor-groups/flexlayout-spike";

interface DockLayoutRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  initialPaneIds: string[];
  expandedPaneIds: string[];
  initialPaneCount: number;
  expandedPaneCount: number;
  layoutStatePaneCount: number;
  dropDirections: string[];
  splitterSymmetry: Array<{
    orientation: "horizontal" | "vertical";
    growBeforeWeights: number[];
    growAfterWeights: number[];
    mirrored: boolean;
  }>;
  floating: {
    actionType: string;
    requestedType: string;
    subLayoutTypes: string[];
    floatingLayoutCreated: boolean;
  };
  cssBridge: {
    hostClassApplied: boolean;
    appPrimaryVar: string;
    bridgePrimaryVar: string;
    layoutDragColor: string;
    tabsetDividerColor: string;
    paneBackground: string;
    paneBorderColor: string;
    primaryLooksOklch: boolean;
    bridgePrimaryMatchesApp: boolean;
    dragColorApplied: boolean;
    dividerColorApplied: boolean;
    panelBackgroundApplied: boolean;
    panelBorderApplied: boolean;
  };
  strictMode: {
    iterations: number;
    leakSignals: string[];
    leakSignalCount: number;
  };
  deliberateFailSignature: {
    missingPaneDetected: boolean;
    fourPaneCount: number;
    expectedPaneCount: number;
  };
  packageImpact: {
    flexlayoutVersion: string;
    dependencyPinned: boolean;
  };
  reason?: string;
}

declare global {
  interface Window {
    __nexusDockLayoutRuntimeSmokeResult?: DockLayoutRuntimeSmokeResult;
  }
}

const capturedErrors: string[] = [];
const suspiciousMessagePattern =
  /Maximum update depth exceeded|ResizeObserver loop completed with undelivered notifications|Cannot update a component|error boundary|uncaught|unhandled|flexlayout/i;
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
  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);

    const initialModel = createFourPaneSpikeModel();
    const root = createRoot(rootElement);
    root.render(
      <StrictMode>
        <FlexLayoutSpike model={initialModel} />
      </StrictMode>,
    );
    await waitForPaneCount(4);
    const initialPaneIds = visiblePaneIds();
    const initialPaneCount = initialPaneIds.length;

    expandFourPaneModelToSixSplits(initialModel);
    root.render(
      <StrictMode>
        <FlexLayoutSpike model={initialModel} />
      </StrictMode>,
    );
    await waitForPaneCount(6);
    const expandedPaneIds = visiblePaneIds();
    const expandedPaneCount = expandedPaneIds.length;
    const layoutStatePaneCount = countSpikeModelPanes(initialModel).panes;
    const cssBridge = collectCssBridgeEvidence();
    root.unmount();
    await animationFrame();

    const dropDirections = [...collectDropOverlayDirections()];
    const splitterSymmetry = probeSplitterSymmetry().map((probe) => ({
      orientation: probe.orientation,
      growBeforeWeights: [...probe.growBeforeWeights],
      growAfterWeights: [...probe.growAfterWeights],
      mirrored: probe.mirrored,
    }));
    const floatingProbe = probeFloatingPanelCapability();
    const floating = {
      actionType: floatingProbe.actionType,
      requestedType: floatingProbe.requestedType,
      subLayoutTypes: [...floatingProbe.subLayoutTypes],
      floatingLayoutCreated: floatingProbe.floatingLayoutCreated,
    };
    const strictMode = await runStrictModeMountUnmountProbe(rootElement);
    const fourPaneCount = countSpikeModelPanes(createFourPaneSpikeModel()).panes;
    const deliberateFailSignature = {
      missingPaneDetected: fourPaneCount !== FLEX_LAYOUT_SPIKE_MAX_PANES,
      fourPaneCount,
      expectedPaneCount: FLEX_LAYOUT_SPIKE_MAX_PANES,
    };
    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const packageImpact = {
      flexlayoutVersion: "0.9.0",
      dependencyPinned: true,
    };

    const ok =
      fatalErrors.length === 0 &&
      initialPaneCount === 4 &&
      expandedPaneCount === FLEX_LAYOUT_SPIKE_MAX_PANES &&
      layoutStatePaneCount === FLEX_LAYOUT_SPIKE_MAX_PANES &&
      hasRequiredDropOverlayDirections(dropDirections) &&
      splitterSymmetry.every((probe) => probe.mirrored) &&
      floating.floatingLayoutCreated &&
      cssBridge.hostClassApplied &&
      cssBridge.primaryLooksOklch &&
      cssBridge.bridgePrimaryMatchesApp &&
      cssBridge.dragColorApplied &&
      cssBridge.dividerColorApplied &&
      cssBridge.panelBackgroundApplied &&
      cssBridge.panelBorderApplied &&
      strictMode.iterations === FLEX_LAYOUT_STRICT_MODE_SMOKE_ITERATIONS &&
      strictMode.leakSignalCount === 0 &&
      deliberateFailSignature.missingPaneDetected &&
      packageImpact.dependencyPinned;

    publishResult({
      ok,
      errors: fatalErrors,
      initialPaneIds,
      expandedPaneIds,
      initialPaneCount,
      expandedPaneCount,
      layoutStatePaneCount,
      dropDirections,
      splitterSymmetry,
      floating,
      cssBridge,
      strictMode,
      deliberateFailSignature,
      packageImpact,
      reason:
        fatalErrors[0] ??
        (initialPaneCount !== 4 ? `Expected 4 initial panes, saw ${initialPaneCount}` : undefined) ??
        (expandedPaneCount !== FLEX_LAYOUT_SPIKE_MAX_PANES
          ? `Expected ${FLEX_LAYOUT_SPIKE_MAX_PANES} expanded panes, saw ${expandedPaneCount}`
          : undefined) ??
        (!hasRequiredDropOverlayDirections(dropDirections) ? `Missing dock drop direction from ${dropDirections.join(",")}` : undefined) ??
        (!splitterSymmetry.every((probe) => probe.mirrored) ? "Splitter symmetry probe found asymmetric growth." : undefined) ??
        (!floating.floatingLayoutCreated ? "Floating tear-off model probe did not create a float sublayout." : undefined) ??
        (!cssBridge.primaryLooksOklch ? `CSS primary variable was not oklch: ${cssBridge.appPrimaryVar}` : undefined) ??
        (!cssBridge.panelBackgroundApplied ? `Panel background bridge missing: ${cssBridge.paneBackground}` : undefined) ??
        (!cssBridge.panelBorderApplied ? `Panel border bridge missing: ${cssBridge.paneBorderColor}` : undefined) ??
        (strictMode.leakSignalCount > 0 ? strictMode.leakSignals[0] : undefined) ??
        (!deliberateFailSignature.missingPaneDetected ? "Deliberate missing-pane fail signature did not trip." : undefined),
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

async function runStrictModeMountUnmountProbe(rootElement: HTMLElement): Promise<DockLayoutRuntimeSmokeResult["strictMode"]> {
  const leakSignals: string[] = [];

  for (let iteration = 0; iteration < FLEX_LAYOUT_STRICT_MODE_SMOKE_ITERATIONS; iteration += 1) {
    rootElement.replaceChildren();
    const mount = document.createElement("div");
    mount.dataset.strictModeIteration = String(iteration + 1);
    mount.style.width = "100%";
    mount.style.height = "100%";
    rootElement.append(mount);

    let root: Root | null = createRoot(mount);
    root.render(
      <StrictMode>
        <FlexLayoutSpike model={createSixSplitSpikeModel()} />
      </StrictMode>,
    );
    await waitForPaneCount(FLEX_LAYOUT_SPIKE_MAX_PANES, mount);
    root.unmount();
    root = null;
    await animationFrame();

    if (mount.querySelector(".flexlayout__layout")) {
      leakSignals.push(`Iteration ${iteration + 1} left a flexlayout DOM node after unmount.`);
    }
    mount.remove();
    await animationFrame();
  }

  return {
    iterations: FLEX_LAYOUT_STRICT_MODE_SMOKE_ITERATIONS,
    leakSignals,
    leakSignalCount: leakSignals.length,
  };
}

function collectCssBridgeEvidence(): DockLayoutRuntimeSmokeResult["cssBridge"] {
  const host = document.querySelector<HTMLElement>('[data-flexlayout-spike="true"]');
  const layout = document.querySelector<HTMLElement>(".flexlayout__layout");
  const tabset = document.querySelector<HTMLElement>(".flexlayout__tabset");
  const pane = document.querySelector<HTMLElement>(".nexus-flexlayout-spike__pane");
  const hostStyles = host ? getComputedStyle(host) : null;
  const layoutStyles = layout ? getComputedStyle(layout) : null;
  const tabsetStyles = tabset ? getComputedStyle(tabset) : null;
  const paneStyles = pane ? getComputedStyle(pane) : null;
  const appPrimaryVar = getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim();
  const bridgePrimaryVar = hostStyles?.getPropertyValue("--nx-flexlayout-primary").trim() ?? "";
  const layoutDragColor = layoutStyles?.getPropertyValue("--color-drag1").trim() ?? "";
  const tabsetDividerColor = layoutStyles?.getPropertyValue("--color-tabset-divider-line").trim() ?? "";
  const paneBackground = paneStyles?.backgroundColor ?? "";
  const paneBorderColor = tabsetStyles?.getPropertyValue("--color-tabset-divider-line").trim() ?? "";

  return {
    hostClassApplied: host?.classList.contains("nexus-flexlayout-spike") ?? false,
    appPrimaryVar,
    bridgePrimaryVar,
    layoutDragColor,
    tabsetDividerColor,
    paneBackground,
    paneBorderColor,
    primaryLooksOklch: appPrimaryVar.includes("oklch("),
    bridgePrimaryMatchesApp: bridgePrimaryVar === appPrimaryVar,
    dragColorApplied: layoutDragColor === appPrimaryVar,
    dividerColorApplied: tabsetDividerColor === getComputedStyle(document.documentElement).getPropertyValue("--color-border").trim(),
    panelBackgroundApplied: paneBackground !== "" && paneBackground !== "rgba(0, 0, 0, 0)",
    panelBorderApplied: paneBorderColor === getComputedStyle(document.documentElement).getPropertyValue("--color-border").trim(),
  };
}

async function waitForPaneCount(expectedCount: number, root: ParentNode = document, timeoutMs = 5_000): Promise<void> {
  await waitUntil(() => visiblePaneIds(root).length === expectedCount, timeoutMs, () => {
    const ids = visiblePaneIds(root);
    return `Timed out waiting for ${expectedCount} visible panes; saw ${ids.length}: ${ids.join(",")}`;
  });
}

function visiblePaneIds(root: ParentNode = document): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-flexlayout-spike-tab]"))
    .filter((element) => element.offsetParent !== null)
    .map((element) => element.dataset.flexlayoutSpikeTab ?? "")
    .filter((id) => id.startsWith("pane-"))
    .sort();
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
  document.documentElement.style.height = "900px";
  document.body.style.width = "1200px";
  document.body.style.height = "900px";
  document.body.style.margin = "0";
  rootElement.style.width = "1200px";
  rootElement.style.height = "900px";
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function failedResult(reason: string): DockLayoutRuntimeSmokeResult {
  return {
    ok: false,
    errors: [reason],
    initialPaneIds: [],
    expandedPaneIds: [],
    initialPaneCount: 0,
    expandedPaneCount: 0,
    layoutStatePaneCount: 0,
    dropDirections: [],
    splitterSymmetry: [],
    floating: {
      actionType: "",
      requestedType: "",
      subLayoutTypes: [],
      floatingLayoutCreated: false,
    },
    cssBridge: {
      hostClassApplied: false,
      appPrimaryVar: "",
      bridgePrimaryVar: "",
      layoutDragColor: "",
      tabsetDividerColor: "",
      paneBackground: "",
      paneBorderColor: "",
      primaryLooksOklch: false,
      bridgePrimaryMatchesApp: false,
      dragColorApplied: false,
      dividerColorApplied: false,
      panelBackgroundApplied: false,
      panelBorderApplied: false,
    },
    strictMode: {
      iterations: 0,
      leakSignals: [],
      leakSignalCount: 0,
    },
    deliberateFailSignature: {
      missingPaneDetected: false,
      fourPaneCount: 0,
      expectedPaneCount: FLEX_LAYOUT_SPIKE_MAX_PANES,
    },
    packageImpact: {
      flexlayoutVersion: "0.9.0",
      dependencyPinned: true,
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

function publishResult(result: DockLayoutRuntimeSmokeResult): void {
  window.__nexusDockLayoutRuntimeSmokeResult = result;
}
