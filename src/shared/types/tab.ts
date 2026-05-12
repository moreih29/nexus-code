import { z } from "zod";

const TabIdSchema = z.string().uuid();
const WorkspaceIdSchema = z.string().uuid();

const TabBaseSchema = z.object({
  id: TabIdSchema,
  workspaceId: WorkspaceIdSchema,
  title: z.string(),
  isPreview: z.boolean().optional(),
});

export const DiffTabPayloadSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  relPath: z.string().min(1),
  leftRef: z.string().min(1),
  rightRef: z.string().min(1),
  oldRelPath: z.string().min(1).optional(),
});
export type DiffTabPayload = z.infer<typeof DiffTabPayloadSchema>;

export const GitCommitTabPayloadSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sha: z.string().min(1),
});
export type GitCommitTabPayload = z.infer<typeof GitCommitTabPayloadSchema>;

export const TabMetaSchema = z.discriminatedUnion("type", [
  TabBaseSchema.extend({
    type: z.literal("terminal"),
    cwd: z.string(),
  }),
  TabBaseSchema.extend({
    type: z.literal("agent"),
    cwd: z.string(),
    agentKind: z.enum(["claude-code", "codex", "custom"]).optional(),
  }),
  TabBaseSchema.extend({
    type: z.literal("editor"),
    cwd: z.string().optional(),
    filePath: z.string(),
  }),
  DiffTabPayloadSchema.extend({
    id: TabIdSchema,
    type: z.literal("editor.diff"),
    title: z.string(),
    isPreview: z.boolean().optional(),
  }),
  GitCommitTabPayloadSchema.extend({
    id: TabIdSchema,
    type: z.literal("git.commit"),
    title: z.string(),
    isPreview: z.boolean().optional(),
  }),
]);

export type TabMeta = z.infer<typeof TabMetaSchema>;
