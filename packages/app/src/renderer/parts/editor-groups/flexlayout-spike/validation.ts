import {
  Actions,
  DockLocation,
  Model,
  Rect,
  type IJsonModel,
  type IJsonSubLayout,
  type ILayoutType,
} from "flexlayout-react";

import {
  FLEX_LAYOUT_SPIKE_COMPONENT,
  FLEX_LAYOUT_SPIKE_MAX_PANES,
  countSpikeModelPanes,
  createFourPaneSpikeModel,
  createSixSplitSpikeModel,
} from "./model";

export const FLEX_LAYOUT_REQUIRED_DROP_DIRECTIONS = ["top", "right", "bottom", "left"] as const;
export const FLEX_LAYOUT_STRICT_MODE_SMOKE_ITERATIONS = 5;

export type FlexLayoutDropDirection = typeof FLEX_LAYOUT_REQUIRED_DROP_DIRECTIONS[number];

export type FlexLayoutSplitterSymmetryProbe = {
  orientation: "horizontal" | "vertical";
  growBeforeWeights: readonly number[];
  growAfterWeights: readonly number[];
  mirrored: boolean;
};

export type FlexLayoutFloatingProbe = {
  actionType: string;
  requestedType: ILayoutType;
  subLayoutTypes: readonly ILayoutType[];
  floatingLayoutCreated: boolean;
};

export type FlexLayoutAdoptionEvidence = {
  sixPaneModel: boolean;
  dropDirections: readonly string[];
  splitterSymmetry: readonly FlexLayoutSplitterSymmetryProbe[];
  floating: FlexLayoutFloatingProbe;
  strictModeIterations: number;
};

export function collectFlexLayoutAdoptionEvidence(): FlexLayoutAdoptionEvidence {
  const sixPaneModel = createSixSplitSpikeModel();

  return {
    sixPaneModel: countSpikeModelPanes(sixPaneModel).panes === FLEX_LAYOUT_SPIKE_MAX_PANES,
    dropDirections: collectDropOverlayDirections(),
    splitterSymmetry: probeSplitterSymmetry(),
    floating: probeFloatingPanelCapability(),
    strictModeIterations: FLEX_LAYOUT_STRICT_MODE_SMOKE_ITERATIONS,
  };
}

export function collectDropOverlayDirections(): readonly string[] {
  const rect = new Rect(0, 0, 400, 400);
  const samplePoints = [
    { x: 200, y: 1 },
    { x: 399, y: 200 },
    { x: 200, y: 399 },
    { x: 1, y: 200 },
    { x: 200, y: 200 },
  ];

  return Array.from(new Set(samplePoints.map(({ x, y }) => DockLocation.getLocation(rect, x, y).getName())));
}

export function hasRequiredDropOverlayDirections(directions: readonly string[]): boolean {
  return FLEX_LAYOUT_REQUIRED_DROP_DIRECTIONS.every((direction) => directions.includes(direction));
}

export function probeSplitterSymmetry(): readonly FlexLayoutSplitterSymmetryProbe[] {
  return [probeTwoPaneSplitter(false), probeTwoPaneSplitter(true)];
}

export function probeFloatingPanelCapability(): FlexLayoutFloatingProbe {
  const model = createFourPaneSpikeModel();
  const action = Actions.popoutTab("pane-1-tab", "float");
  model.doAction(action);

  const subLayouts = Object.values(model.toJson().subLayouts ?? {}) as IJsonSubLayout[];
  const subLayoutTypes = subLayouts.map((subLayout) => subLayout.type).filter(isLayoutType);

  return {
    actionType: action.type,
    requestedType: "float",
    subLayoutTypes,
    floatingLayoutCreated: subLayoutTypes.includes("float"),
  };
}

function probeTwoPaneSplitter(rootOrientationVertical: boolean): FlexLayoutSplitterSymmetryProbe {
  const model = Model.fromJson(createTwoPaneSplitterJson(rootOrientationVertical));
  const root = model.getRootRow();
  const children = root.getChildren();
  const orientation = rootOrientationVertical ? "vertical" : "horizontal";

  model.setSplitterSize(0);
  root.setRect(new Rect(0, 0, 200, 200));
  children[0]?.setRect(new Rect(0, 0, 100, 100));
  children[1]?.setRect(new Rect(rootOrientationVertical ? 0 : 100, rootOrientationVertical ? 100 : 0, 100, 100));
  children.forEach((child) => {
    if (isMinMaxCalculable(child)) {
      child.calcMinMaxSize();
    }
  });
  root.calcMinMaxSize();

  const initial = root.getSplitterInitials(1);
  const growAfterWeights = root.calculateSplit(
    1,
    initial.startPosition - 20,
    initial.initialSizes,
    initial.sum,
    initial.startPosition,
  );
  const growBeforeWeights = root.calculateSplit(
    1,
    initial.startPosition + 20,
    initial.initialSizes,
    initial.sum,
    initial.startPosition,
  );

  return {
    orientation,
    growBeforeWeights,
    growAfterWeights,
    mirrored: weightsMirror(growBeforeWeights, growAfterWeights),
  };
}

function createTwoPaneSplitterJson(rootOrientationVertical: boolean): IJsonModel {
  return {
    global: {
      rootOrientationVertical,
    },
    layout: {
      type: "row",
      id: `splitter-${rootOrientationVertical ? "vertical" : "horizontal"}`,
      children: [
        {
          type: "tabset",
          id: "splitter-before",
          minWidth: 1,
          minHeight: 1,
          maxWidth: 99999,
          maxHeight: 99999,
          children: [
            {
              type: "tab",
              id: "splitter-before-tab",
              name: "Before",
              component: FLEX_LAYOUT_SPIKE_COMPONENT,
              minWidth: 1,
              minHeight: 1,
              maxWidth: 99999,
              maxHeight: 99999,
            },
          ],
        },
        {
          type: "tabset",
          id: "splitter-after",
          minWidth: 1,
          minHeight: 1,
          maxWidth: 99999,
          maxHeight: 99999,
          children: [
            {
              type: "tab",
              id: "splitter-after-tab",
              name: "After",
              component: FLEX_LAYOUT_SPIKE_COMPONENT,
              minWidth: 1,
              minHeight: 1,
              maxWidth: 99999,
              maxHeight: 99999,
            },
          ],
        },
      ],
    },
  } satisfies IJsonModel;
}

function weightsMirror(before: readonly number[], after: readonly number[]): boolean {
  return before.length === after.length && before.every((weight, index) => isNearlyEqual(weight, after[after.length - index - 1]));
}

function isNearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

type MinMaxCalculable = {
  calcMinMaxSize(): void;
};

function isMinMaxCalculable(node: unknown): node is MinMaxCalculable {
  return typeof (node as Partial<MinMaxCalculable>).calcMinMaxSize === "function";
}

function isLayoutType(type: IJsonSubLayout["type"]): type is ILayoutType {
  return type === "window" || type === "float" || type === "tab";
}
