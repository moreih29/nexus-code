/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


/**
 * This interface was referenced by `LastSessionSnapshot`'s JSON-Schema
 * via the `definition` "workspaceId".
 */

export interface LastSessionSnapshot {
  version: 1;
  openWorkspaceIds: WorkspaceId[];
  activeWorkspaceId: WorkspaceId | null;
  capturedAt: string;
}
