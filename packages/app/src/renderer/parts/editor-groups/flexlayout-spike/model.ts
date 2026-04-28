import {
  Actions,
  DockLocation,
  Model,
  TabNode,
  TabSetNode,
  type IJsonModel,
  type IJsonTabNode,
} from "flexlayout-react";

export const FLEX_LAYOUT_SPIKE_COMPONENT = "nexus-flexlayout-spike-pane";
export const FLEX_LAYOUT_SPIKE_MAX_PANES = 6;

export type FlexLayoutSpikePane = {
  id: string;
  title: string;
};

export type FlexLayoutSpikeModelCounts = {
  panes: number;
  tabs: number;
};

export const FLEX_LAYOUT_SPIKE_INITIAL_PANES: readonly FlexLayoutSpikePane[] = [
  { id: "pane-1", title: "Editor 1" },
  { id: "pane-2", title: "Editor 2" },
  { id: "pane-3", title: "Editor 3" },
  { id: "pane-4", title: "Terminal" },
];

export const FLEX_LAYOUT_SPIKE_EXPANSION_TABS: readonly FlexLayoutSpikePane[] = [
  { id: "pane-5", title: "Diff" },
  { id: "pane-6", title: "Output" },
];

export function createFourPaneSpikeJson(): IJsonModel {
  return {
    global: {
      enableEdgeDock: true,
      enableEdgeDockIndicators: true,
      tabEnablePopout: true,
      tabEnablePopoutFloatIcon: true,
    },
    borders: [
      {
        type: "border",
        location: "bottom",
        selected: 0,
        children: [createTab({ id: "bottom-terminal", title: "Terminal" })],
      },
    ],
    layout: {
      type: "row",
      id: "root",
      weight: 100,
      children: FLEX_LAYOUT_SPIKE_INITIAL_PANES.map((pane) => ({
        type: "tabset",
        id: pane.id,
        weight: 25,
        children: [createTab(pane)],
      })),
    },
  } satisfies IJsonModel;
}

export function createFourPaneSpikeModel(): Model {
  return Model.fromJson(createFourPaneSpikeJson());
}

export function createSixSplitSpikeModel(): Model {
  const model = createFourPaneSpikeModel();
  expandFourPaneModelToSixSplits(model);
  return model;
}

export function expandFourPaneModelToSixSplits(model: Model): Model {
  model.doAction(
    Actions.addTab(
      createTab(FLEX_LAYOUT_SPIKE_EXPANSION_TABS[0]),
      "pane-1",
      DockLocation.RIGHT,
      -1,
      true,
    ),
  );
  model.doAction(
    Actions.addTab(
      createTab(FLEX_LAYOUT_SPIKE_EXPANSION_TABS[1]),
      "pane-2",
      DockLocation.BOTTOM,
      -1,
      true,
    ),
  );

  return model;
}

export function countSpikeModelPanes(model: Model): FlexLayoutSpikeModelCounts {
  const counts = { panes: 0, tabs: 0 };

  model.visitNodes((node) => {
    if (node instanceof TabSetNode && node.getChildren().length > 0) {
      counts.panes += 1;
    }

    if (node instanceof TabNode) {
      counts.tabs += 1;
    }
  });

  return counts;
}

export function createTab(pane: FlexLayoutSpikePane): IJsonTabNode {
  return {
    type: "tab",
    id: `${pane.id}-tab`,
    name: pane.title,
    component: FLEX_LAYOUT_SPIKE_COMPONENT,
    enablePopout: true,
    enablePopoutFloatIcon: true,
  };
}
