import { z } from "zod";

/** Canonical primitive for a workspace UUID field. */
export const WorkspaceIdSchema = z.string().uuid();

/**
 * Returns a `z.object` that always includes `workspaceId: WorkspaceIdSchema`
 * alongside any caller-supplied extra fields.
 *
 * Usage:
 *   workspaceScoped({ relPath: z.string() })
 *   // → z.object({ workspaceId: WorkspaceIdSchema, relPath: z.string() })
 */
export function workspaceScoped<T extends z.ZodRawShape>(extra: T) {
  return z.object({ workspaceId: WorkspaceIdSchema, ...extra });
}
