import { z } from "zod";

// ---------------------------------------------------------------------------
// Tab props schemas (serialization form — mirrors renderer/state/stores/tabs.ts
// interfaces but as zod schemas for persistence)
// ---------------------------------------------------------------------------

export const TerminalTabPropsSchema = z.object({
  cwd: z.string(),
});
export type TerminalTabProps = z.infer<typeof TerminalTabPropsSchema>;

export const EditorTabPropsSchema = z.object({
  filePath: z.string(),
  workspaceId: z.string().uuid(),
});
export type EditorTabProps = z.infer<typeof EditorTabPropsSchema>;

// ---------------------------------------------------------------------------
// SerializedTab
// ---------------------------------------------------------------------------

export const SerializedTabSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().uuid(),
    type: z.literal("terminal"),
    title: z.string(),
    props: TerminalTabPropsSchema,
    isPreview: z.boolean().optional(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("editor"),
    title: z.string(),
    props: EditorTabPropsSchema,
    isPreview: z.boolean().optional(),
  }),
]);
export type SerializedTab = z.infer<typeof SerializedTabSchema>;

// ---------------------------------------------------------------------------
// Split orientation
// ---------------------------------------------------------------------------

export const SplitOrientationSchema = z.enum(["horizontal", "vertical"]);
export type SplitOrientation = z.infer<typeof SplitOrientationSchema>;

// ---------------------------------------------------------------------------
// LayoutNode — recursive binary tree
//
// zod's discriminatedUnion requires ZodObject members, so the recursive
// SerializedSplit cannot itself be a ZodType<SerializedSplit> when used
// inside discriminatedUnion. Instead we build a single z.lazy wrapper around
// a plain z.union and give it an explicit TypeScript type annotation.
// ---------------------------------------------------------------------------

export interface SerializedLeaf {
  kind: "leaf";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SerializedSplit {
  kind: "split";
  id: string;
  orientation: "horizontal" | "vertical";
  ratio: number;
  first: SerializedNode;
  second: SerializedNode;
}

export type SerializedNode = SerializedLeaf | SerializedSplit;

// Leaf schema — no recursion, straightforward ZodObject
export const SerializedLeafSchema = z.object({
  kind: z.literal("leaf"),
  id: z.string().uuid(),
  tabIds: z.array(z.string().uuid()),
  activeTabId: z.string().uuid().nullable(),
});

// Node schema — z.lazy wraps both variants to allow self-reference.
// We use z.union instead of z.discriminatedUnion here because
// z.discriminatedUnion requires ZodObject members, which cannot be satisfied
// once one of the members is itself wrapped in z.lazy.
export const SerializedNodeSchema: z.ZodType<SerializedNode> = z.lazy(() =>
  z.union([
    SerializedLeafSchema,
    z.object({
      kind: z.literal("split"),
      id: z.string().uuid(),
      orientation: SplitOrientationSchema,
      ratio: z.number().min(0.05).max(0.95),
      first: SerializedNodeSchema,
      second: SerializedNodeSchema,
    }),
  ]),
);

// ---------------------------------------------------------------------------
// WorkspaceLayoutSnapshot
// ---------------------------------------------------------------------------

export const WorkspaceLayoutSnapshotSchema = z.object({
  root: SerializedNodeSchema,
  activeGroupId: z.string().uuid(),
  tabs: z.array(SerializedTabSchema),
});
export type WorkspaceLayoutSnapshot = z.infer<typeof WorkspaceLayoutSnapshotSchema>;
