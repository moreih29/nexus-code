import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Actions } from "flexlayout-react";

import { FlexLayoutSpike } from "./FlexLayoutSpike";
import {
  FLEX_LAYOUT_SPIKE_MAX_PANES,
  countSpikeModelPanes,
  createFourPaneSpikeModel,
  createSixSplitSpikeModel,
  expandFourPaneModelToSixSplits,
} from "./model";
import {
  FLEX_LAYOUT_REQUIRED_DROP_DIRECTIONS,
  FLEX_LAYOUT_STRICT_MODE_SMOKE_ITERATIONS,
  collectDropOverlayDirections,
  collectFlexLayoutAdoptionEvidence,
  hasRequiredDropOverlayDirections,
  probeFloatingPanelCapability,
  probeSplitterSymmetry,
} from "./validation";

describe("flexlayout-react adoption spike", () => {
  test("pins flexlayout-react at the exact spike version", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8"));

    expect(packageJson.dependencies["flexlayout-react"]).toBe("0.9.0");
  });

  test("expands the initial four pane model to six split panes", () => {
    const model = createFourPaneSpikeModel();

    expect(countSpikeModelPanes(model).panes).toBe(4);

    expandFourPaneModelToSixSplits(model);
    const counts = countSpikeModelPanes(model);
    const json = JSON.stringify(model.toJson());

    expect(counts.panes).toBe(FLEX_LAYOUT_SPIKE_MAX_PANES);
    expect(json).toContain("pane-5-tab");
    expect(json).toContain("pane-6-tab");
  });

  test("maps drag overlay hit testing to top, right, bottom, and left", () => {
    const directions = collectDropOverlayDirections();

    expect(hasRequiredDropOverlayDirections(directions)).toBe(true);
    expect(directions).toContain("center");
    expect([...FLEX_LAYOUT_REQUIRED_DROP_DIRECTIONS].sort()).toEqual(["bottom", "left", "right", "top"]);
  });

  test("keeps splitter solver symmetric for horizontal and vertical spike paths", () => {
    const probes = probeSplitterSymmetry();

    expect(probes).toHaveLength(2);

    for (const probe of probes) {
      expect(probe.mirrored).toBe(true);
      expect(probe.growBeforeWeights).toEqual([60, 40]);
      expect(probe.growAfterWeights).toEqual([40, 60]);
    }
  });

  test("exposes floating tear-off via the model popout API", () => {
    const probe = probeFloatingPanelCapability();

    expect(probe.actionType).toBe(Actions.POPOUT_TAB);
    expect(probe.requestedType).toBe("float");
    expect(probe.floatingLayoutCreated).toBe(true);
    expect(probe.subLayoutTypes).toContain("float");
  });

  test("bridges app oklch theme variables through prefixed flexlayout variables", () => {
    const bridgeCss = readFileSync(new URL("../flexlayout-theme.css", import.meta.url), "utf8");
    const appCss = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");

    expect(appCss).toContain("--color-primary: oklch(");
    expect(bridgeCss).toContain('@import "flexlayout-react/style/alpha_dark.css";');
    expect(bridgeCss).toContain("--nx-flexlayout-primary: var(--color-primary);");
    expect(bridgeCss).toContain("--nx-flexlayout-primary-soft: color-mix(in oklch");
    expect(bridgeCss).toContain("--color-drag1: var(--nx-flexlayout-primary);");
    expect(bridgeCss).toContain("--color-tabset-divider-line: var(--nx-flexlayout-border);");
    expect(bridgeCss).not.toContain("--color-background: var(--color-background);");
  });

  test("renders the spike through React 19 StrictMode five times", () => {
    for (let iteration = 0; iteration < FLEX_LAYOUT_STRICT_MODE_SMOKE_ITERATIONS; iteration += 1) {
      const markup = renderToStaticMarkup(
        <StrictMode>
          <FlexLayoutSpike model={createSixSplitSpikeModel()} />
        </StrictMode>,
      );

      expect(markup).toContain('data-flexlayout-spike="true"');
      expect(markup).toContain("flexlayout__layout");
    }
  });

  test("collects adoption evidence in one helper for Lead reporting", () => {
    const evidence = collectFlexLayoutAdoptionEvidence();

    expect(evidence.sixPaneModel).toBe(true);
    expect(hasRequiredDropOverlayDirections(evidence.dropDirections)).toBe(true);
    expect(evidence.splitterSymmetry.every((probe) => probe.mirrored)).toBe(true);
    expect(evidence.floating.floatingLayoutCreated).toBe(true);
    expect(evidence.strictModeIterations).toBe(5);
  });
});
