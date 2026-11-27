import { z } from "zod";
import { DeviceIdSchema } from "../../../packages/remote-protocol/src/relay";
import {
  NumberSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";
import { isRemoteFileKey, parseRemoteFileKey } from "../fs/remote-file-key";

export const AgentViewModeSchema = z.enum(["workspace", "agents"]);
export type AgentViewMode = z.infer<typeof AgentViewModeSchema>;

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
  tabId: z.string().optional(),
});
export type RemoteFileSnapshot = z.infer<typeof RemoteFileSnapshotSchema>;

export interface AgentViewLeaf {
  kind: "leaf";
  id: string;
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
  listedAt: z.number().nullable().optional(),
});
export type RemoteSeenResult = z.infer<typeof RemoteSeenResultSchema>;

const MAX_FOLDS = 256;
const MAX_FOLD_KEY_LENGTH = 200;

function isPeerFold(key: string): boolean {
  return (
    key.startsWith("peer:") ||
    key.startsWith("peer-ws:") ||
    key.startsWith("family:remote:") ||
    key.startsWith("peer-hash:")
  );
}

export function boundedPeerFoldKey(key: string): string {
  if (key.length <= MAX_FOLD_KEY_LENGTH) return key;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < key.length; i++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(key.charCodeAt(i))) * 0x100000001b3n);
  }
  return `peer-hash:${hash.toString(16)}`;
}

export function normalizeAgentViewFolds(values: Iterable<unknown>): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const key = isPeerFold(value) ? boundedPeerFoldKey(value) : value;
    if (key.length > MAX_FOLD_KEY_LENGTH) continue;
    keys.delete(key);
    keys.add(key);
  }
  for (const key of keys) {
    if (keys.size <= MAX_FOLDS) break;
    if (isPeerFold(key)) keys.delete(key);
  }
  return [...keys].slice(-MAX_FOLDS);
}

export const AgentViewSnapshotSchema = z.object({
  mode: AgentViewModeSchema,
  root: AgentViewNodeSchema,
  activeLeafId: z.guid(),
  remoteFiles: z.record(RemoteFileKeySchema, RemoteFileSnapshotSchema).optional().catch(undefined),
  ended: z.record(SessionKeySchema, EndedAgentSnapshotSchema).optional().catch(undefined),
  order: z.record(z.string().max(200), z.array(SessionKeySchema)).optional().catch(undefined),
  peerOrder: z
    .object({ accountKey: z.string(), ids: z.array(DeviceIdSchema) })
    .optional()
    .catch(undefined),
  grouping: z.string().max(32).optional().catch(undefined),
  folded: z.array(z.unknown()).transform(normalizeAgentViewFolds).optional().catch(undefined),
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
