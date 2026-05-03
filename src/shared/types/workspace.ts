import { z } from "zod";
import { ColorToneSchema } from "./color-tone";
import { TabMetaSchema } from "./tab";

export const WorkspaceMetaSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  rootPath: z.string(),
  colorTone: ColorToneSchema,
  pinned: z.boolean(),
  lastOpenedAt: z.string().datetime().optional(),
  tabs: z.array(TabMetaSchema),
});

export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;
