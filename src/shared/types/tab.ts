import { z } from "zod";

export const TabMetaSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  type: z.enum(["terminal", "agent", "editor"]),
  title: z.string(),
  cwd: z.string(),
  agentKind: z.enum(["claude-code", "codex", "custom"]).optional(),
  filePath: z.string().optional(),
});

export type TabMeta = z.infer<typeof TabMetaSchema>;
