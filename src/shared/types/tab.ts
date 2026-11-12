import { z } from "zod";
import { WorkspaceIdSchema } from "./workspace-id";

const TabIdSchema = z.string().uuid();

const TabBaseSchema = z.object({
  id: TabIdSchema,
  workspaceId: WorkspaceIdSchema,
  /**
   * Display title — derived value: customTitle ?? processTitle ?? defaultTitle.
   * Stored along with it on serialization for persistence compatibility. On restore the store
   * recomputes it by the same rule, so the serialized value is just a cache.
   */
  title: z.string(),
  /**
   * Default title decided when the tab is created. Fallback when customTitle and processTitle
   * are both empty. Kept permanently (reverted to when the user clears a rename).
   */
  defaultTitle: z.string().optional(),
  /**
   * Title the user set manually. When set it ignores processTitle and pins the title.
   * Entering an empty string clears it, returning to automatic (processTitle/defaultTitle).
   */
  customTitle: z.string().optional(),
  /**
   * Auto-detected title. Updated from OSC 0/1/2 (xterm.js onTitleChange) for terminals and from
   * the page-title-updated event for browsers. Has no effect on the display when customTitle is set.
   */
  processTitle: z.string().optional(),
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

/**
 * BrowserTab payload — fully persisted. `partition` follows the
 * `persist:browser-${workspaceId}` convention; the caller is responsible
 * for constructing the correct value before creating a tab.
 */
export const BrowserTabPayloadSchema = z.object({
  initialUrl: z.string(),
  lastUrl: z.string(),
  partition: z.string(),
});
export type BrowserTabPayload = z.infer<typeof BrowserTabPayloadSchema>;

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
    defaultTitle: z.string().optional(),
    customTitle: z.string().optional(),
    processTitle: z.string().optional(),
    isPreview: z.boolean().optional(),
  }),
  GitCommitTabPayloadSchema.extend({
    id: TabIdSchema,
    type: z.literal("git.commit"),
    title: z.string(),
    defaultTitle: z.string().optional(),
    customTitle: z.string().optional(),
    processTitle: z.string().optional(),
    isPreview: z.boolean().optional(),
  }),
]);

export type TabMeta = z.infer<typeof TabMetaSchema>;
