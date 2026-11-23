import { z } from "zod";

export const WorkspaceIdSchema = z.guid();

export function workspaceScoped<T extends z.core.$ZodShape>(extra: T) {
  return z.object({ workspaceId: WorkspaceIdSchema, ...extra });
}
