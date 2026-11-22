import { z } from "zod";
import { DeviceIdSchema } from "../../../packages/remote-protocol/src/relay";
import {
  NumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import { isRemoteFileKey, parseRemoteFileKey } from "../fs/remote-file-key";

// ---------------------------------------------------------------------------
// The agent view: the agents of every workspace side by side, in panels split
// the way a workspace's groups are. Its panels hold tabs from any workspace
// and peer files. A local tab uses its `${workspaceId}:${tabId}` key.
// ---------------------------------------------------------------------------

/** Which view the window shows: its workspaces, or the agents of all of them. */
export const AgentViewModeSchema = z.enum(["workspace", "agents"]);
export type AgentViewMode = z.infer<typeof AgentViewModeSchema>;

/** A session key: the workspace's id and the tab's, joined by a colon. */
const SessionKeySchema = z
  .string()
  .max(200)
  .regex(/^[^:]+:[^:]+$/)
  .refine((key) => !isRemoteFileKey(key));

const RemoteFileKeySchema = z.string().refine((key) => parseRemoteFileKey(key) !== null);
const PanelKeySchema = z.union([SessionKeySchema, RemoteFileKeySchema]);

const RemoteFileSnapshotSchema = z.object({
  deviceName: z.string(),
  workspaceRoot: z.string(),
  at: z
    .object({ line: PositiveIntegerSchema, column: PositiveIntegerSchema.optional() })
    .optional()
    .catch(undefined),
  mode: z.enum(["raw", "preview"]).optional(),
  compare: z.boolean().optional(),
  compareFrom: z.string().optional(),
});
export type RemoteFileSnapshot = z.infer<typeof RemoteFileSnapshotSchema>;

export interface AgentViewLeaf {
  kind: "leaf";
  id: string;
  /** Tab keys in panel order. */
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
  id: z.guid(),
  tabIds: z.array(PanelKeySchema).max(256),
  activeTabId: PanelKeySchema.nullable(),
});

export const AgentViewNodeSchema: z.ZodType<AgentViewNode> = z.lazy(() =>
  z.union([
    AgentViewLeafSchema,
    z.object({
      kind: z.literal("split"),
      id: z.guid(),
      orientation: z.enum(["horizontal", "vertical"]),
      ratio: NumberSchema.check(z.gte(0.05)).check(z.lte(0.95)),
      first: AgentViewNodeSchema,
      second: AgentViewNodeSchema,
    }),
  ]),
);

/**
 * A terminal agent that ended while a panel held it, as the panel tells it
 * and takes it up again: kept over a restart, since the terminal comes back
 * a shell and nothing else tells what ran there.
 */
export const EndedAgentSnapshotSchema = z.object({
  agent: z.enum(["claude", "codex"]).optional(),
  sessionId: z.string().max(200).optional(),
  prompted: z.boolean(),
});
export type EndedAgentSnapshot = z.infer<typeof EndedAgentSnapshotSchema>;

export const MAX_REMOTE_SEEN = 500;
const RemoteSeenResultSchema = z.object({
  at: z.number(),
  undated: z.literal(true).optional(),
  /** The quiet chat's listing timestamp when its open pane saw it. */
  listedAt: z.number().nullable().optional(),
});
export type RemoteSeenResult = z.infer<typeof RemoteSeenResultSchema>;

export const AgentViewSnapshotSchema = z.object({
  mode: AgentViewModeSchema,
  root: AgentViewNodeSchema,
  activeLeafId: z.guid(),
  remoteFiles: z.record(RemoteFileKeySchema, RemoteFileSnapshotSchema).optional().catch(undefined),
  // The ended agents the panels show, by session key. Ones this version
  // cannot read are dropped rather than costing the panels.
  ended: z.record(SessionKeySchema, EndedAgentSnapshotSchema).optional().catch(undefined),
  // The order the list's agents were dragged into, by the workspace (or
  // task) they run in. A workspace can have more tabs than a single panel.
  order: z.record(z.string().max(200), z.array(SessionKeySchema)).optional().catch(undefined),
  peerOrder: z
    .object({ accountKey: z.string(), ids: z.array(DeviceIdSchema) })
    .optional()
    .catch(undefined),
  // How the list groups its agents: by their state, or by their workspace.
  // Absent, or one this version lacks = by state.
  grouping: z.string().max(32).optional().catch(undefined),
  // The list's folded groups, keyed by status, workspace, peer or peer-ws.
  folded: z.array(z.string().max(200)).max(256).optional().catch(undefined),
  remoteSeen: z
    .object({
      accountKey: z.string(),
      entries: z
        .array(z.tuple([z.string().startsWith("remote:").max(200), RemoteSeenResultSchema]))
        .max(MAX_REMOTE_SEEN),
    })
    .optional()
    .catch(undefined),
});
export type AgentViewSnapshot = z.infer<typeof AgentViewSnapshotSchema>;
