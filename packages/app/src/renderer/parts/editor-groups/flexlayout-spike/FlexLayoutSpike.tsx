import { useMemo } from "react";
import { Layout, type Model, type TabNode } from "flexlayout-react";

import { createSixSplitSpikeModel } from "./model";

export const FLEX_LAYOUT_SPIKE_THEME_CLASS_NAME = "nexus-flexlayout-spike";

export type FlexLayoutSpikeProps = {
  model?: Model;
  className?: string;
};

export function FlexLayoutSpike({ model, className }: FlexLayoutSpikeProps) {
  const fallbackModel = useMemo(() => createSixSplitSpikeModel(), []);
  const layoutModel = model ?? fallbackModel;
  const classNames = [FLEX_LAYOUT_SPIKE_THEME_CLASS_NAME, className].filter(Boolean).join(" ");

  return (
    <div className={classNames} data-flexlayout-spike="true">
      <Layout model={layoutModel} factory={flexLayoutSpikeFactory} />
    </div>
  );
}

export function flexLayoutSpikeFactory(node: TabNode) {
  return (
    <div className="nexus-flexlayout-spike__pane" data-flexlayout-spike-tab={node.getId()}>
      {node.getName()}
    </div>
  );
}
