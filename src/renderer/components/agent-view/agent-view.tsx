// The agent view's panels: the splits of its layout, each leaf a panel of
// agents from any workspace, laid out and resized as a workspace's groups.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Grid, type SplitBranch, type SplitNode } from "@/engine";
import { setRatio } from "@/services/agent-view/layout";
import { mountHeldWorkspaces } from "@/services/agent-view/show";
import { useAgents } from "@/services/agent-view/use-agents";
import { useEndedAgents } from "@/services/agent-view/use-ended";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { cn } from "@/utils/cn";
import type { Agents } from "../../services/agent-view/agents";
import type { EndedAgent } from "../../services/agent-view/ended";
import { ResizeHandleRatio } from "../ui/resize-handle-ratio";
import { AgentPane } from "./agent-pane";

/** The panels, hidden while the workspaces are `shown` instead. */
export function AgentView({ shown }: { shown: boolean }) {
  const root = useAgentViewStore((s) => s.root);
  const agents = useAgents(shown);
  const ended = useEndedAgents(agents, root, shown);
  // An agent of a workspace not opened since launch runs once it is in a
  // panel shown.
  useEffect(() => {
    if (shown) mountHeldWorkspaces(root);
  }, [shown, root]);
  return (
    <div
      className={cn(
        "col-start-1 row-start-1 flex min-h-0 min-w-0 flex-1 overflow-hidden",
        shown ? "visible pointer-events-auto" : "invisible pointer-events-none",
      )}
      aria-hidden={!shown || undefined}
      inert={!shown || undefined}
      data-testid="agent-view"
    >
      <AgentNode node={root} agents={agents} ended={ended} />
    </div>
  );
}

/** What the panels show of the agents. */
interface PanelsProps {
  agents: Agents;
  ended: ReadonlyMap<string, EndedAgent>;
}

function AgentNode({ node, ...panels }: PanelsProps & { node: SplitNode }) {
  if (node.kind === "leaf") return <AgentPane leaf={node} {...panels} />;
  return <AgentSplit split={node} {...panels} />;
}

function AgentSplit({ split, ...panels }: PanelsProps & { split: SplitBranch }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = split.orientation === "horizontal";
  const resize = (ratio: number) =>
    useAgentViewStore.getState().update((layout) => setRatio(layout, split.id, ratio));
  return (
    <div
      ref={containerRef}
      className={`flex ${isHorizontal ? "flex-row" : "flex-col"} min-h-0 min-w-0 flex-1 gap-[6px]`}
    >
      <div
        className="relative flex min-h-0 min-w-0"
        style={{ flexBasis: `calc(${split.ratio * 100}% - 3px)`, flexGrow: 0, flexShrink: 0 }}
      >
        <AgentNode node={split.first} {...panels} />
        <ResizeHandleRatio
          orientation={isHorizontal ? "vertical" : "horizontal"}
          ratio={split.ratio}
          minRatio={Grid.MIN_RATIO}
          maxRatio={Grid.MAX_RATIO}
          getContainerSize={() => {
            const rect = containerRef.current?.getBoundingClientRect();
            return rect ? (isHorizontal ? rect.width : rect.height) : 0;
          }}
          onResize={(ratio) => resize(ratio)}
          onReset={() => resize(0.5)}
          ariaLabel={isHorizontal ? t("resize.horizontal") : t("resize.vertical")}
          placement={isHorizontal ? "rightCentered" : undefined}
        />
      </div>
      <div
        className="relative flex min-h-0 min-w-0"
        style={{ flexBasis: `calc(${(1 - split.ratio) * 100}% - 3px)`, flexGrow: 0, flexShrink: 0 }}
      >
        <AgentNode node={split.second} {...panels} />
      </div>
    </div>
  );
}
