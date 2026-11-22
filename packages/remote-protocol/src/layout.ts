import { z } from "zod";
import { NonnegativeIntegerSchema, NumberSchema } from "./validation.js";

type LayoutNode =
  | { kind: "group"; id: string; shownTabId: string | null; tabIds: readonly string[] }
  | {
      kind: "split";
      id: string;
      direction: "rows" | "columns";
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

const Id = z.string().min(1).max(1024);
const SplitSide = z.enum(["left", "right", "up", "down"]);
const Ratios = z
  .array(z.object({ splitId: Id, ratio: NumberSchema.check(z.gt(0)).check(z.lt(1)) }))
  .max(500);
const Index = NonnegativeIntegerSchema.optional();
const View = z.enum(["agents", "workspaces"]);
const Grouping = z.enum(["status", "workspace"]);

const Node: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("group"),
      id: Id,
      shownTabId: Id.nullable(),
      tabIds: z.array(Id),
    }),
    z.object({
      kind: z.literal("split"),
      id: Id,
      direction: z.enum(["rows", "columns"]),
      ratio: NumberSchema,
      first: Node,
      second: Node,
    }),
  ]),
);

export const WorkspaceLayoutSchema = z.object({
  root: Node,
  activeGroupId: Id,
  tabs: z.array(
    z.object({
      id: Id,
      groupId: Id,
      type: z.string(),
      title: z.string(),
      shown: z.boolean(),
    }),
  ),
});

export const LayoutChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("split"), tabId: Id, groupId: Id, side: SplitSide }),
  z.object({ op: z.literal("move"), tabId: Id, groupId: Id, index: Index }),
  z.object({ op: z.literal("ratios"), ratios: Ratios }),
  z.object({ op: z.literal("close"), groupId: Id, force: z.boolean() }),
  z.object({ op: z.literal("focus"), groupId: Id }),
]);

const ViewAgent = z.object({
  key: Id,
  workspaceId: Id,
  tabId: Id,
  title: z.string(),
  type: z.string(),
});

const HeldTab = z.object({ key: Id, workspaceId: Id, title: z.string() });

export const AgentViewSchema = z.object({
  view: View,
  grouping: Grouping,
  root: Node,
  activePanelId: Id,
  agents: z.array(ViewAgent),
  held: z.array(
    z.discriminatedUnion("kind", [
      HeldTab.extend({ kind: z.literal("file"), path: z.string() }),
      HeldTab.extend({ kind: z.literal("remote-file"), device: z.string(), path: z.string() }),
      HeldTab.extend({
        kind: z.literal("remote-session"),
        device: z.string(),
        path: z.string().optional(),
      }),
    ]),
  ),
});

const ViewTab = z.union([z.object({ key: Id }), z.object({ workspaceId: Id, tabId: Id })]);

export const AgentViewChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("show"), view: View }),
  z.object({
    op: z.literal("place"),
    tab: ViewTab,
    panelId: Id.optional(),
    side: SplitSide.optional(),
    index: Index,
    show: z.boolean(),
  }),
  z.object({
    op: z.literal("openFile"),
    path: z.string().min(1).max(4096),
    panelId: Id.optional(),
  }),
  z.object({ op: z.literal("remove"), tab: ViewTab }),
  z.object({ op: z.literal("close"), panelId: Id }),
  z.object({ op: z.literal("focus"), panelId: Id }),
  z.object({ op: z.literal("ratios"), ratios: Ratios }),
  z.object({ op: z.literal("group"), grouping: Grouping }),
]);
