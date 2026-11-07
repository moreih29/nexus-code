import { z } from "zod";

// ---------------------------------------------------------------------------
// The agent view: the agents of every workspace side by side, in panels split
// the way a workspace's groups are. Its panels hold sessions rather than a
// workspace's tabs, each named by its session key, `${workspaceId}:${tabId}`,
// so one panel can hold agents of different workspaces.
// ---------------------------------------------------------------------------

/** Which view the window shows: its workspaces, or the agents of all of them. */
export const AgentViewModeSchema = z.enum(["workspace", "agents"]);
export type AgentViewMode = z.infer<typeof AgentViewModeSchema>;

/** A session key: the workspace's id and the tab's, joined by a colon. */
const SessionKeySchema = z
  .string()
  .max(200)
  .regex(/^[^:]+:[^:]+$/);

export interface AgentViewLeaf {
  kind: "leaf";
  id: string;
  /** Session keys, in the panel's tab order. */
  tabIds: string[];
  activeTabId: string | null;
}

export interface AgentViewSplit {
  kind: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  ratio: number;
  first: AgentViewNode;
  second: AgentViewNode;
}

export type AgentViewNode = AgentViewLeaf | AgentViewSplit;

const AgentViewLeafSchema = z.object({
  kind: z.literal("leaf"),
  id: z.string().uuid(),
  tabIds: z.array(SessionKeySchema).max(256),
  activeTabId: SessionKeySchema.nullable(),
});

export const AgentViewNodeSchema: z.ZodType<AgentViewNode> = z.lazy(() =>
  z.union([
    AgentViewLeafSchema,
    z.object({
      kind: z.literal("split"),
      id: z.string().uuid(),
      orientation: z.enum(["horizontal", "vertical"]),
      ratio: z.number().min(0.05).max(0.95),
      first: AgentViewNodeSchema,
      second: AgentViewNodeSchema,
    }),
  ]),
);

export const AgentViewSnapshotSchema = z.object({
  mode: AgentViewModeSchema,
  root: AgentViewNodeSchema,
  activeLeafId: z.string().uuid(),
});
export type AgentViewSnapshot = z.infer<typeof AgentViewSnapshotSchema>;
