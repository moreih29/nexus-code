/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


/**
 * This interface was referenced by `WorkspaceRegistry`'s JSON-Schema
 * via the `definition` "workspaceId".
 */

export interface WorkspaceRegistry {
  version: 1;
  workspaces: WorkspaceRegistryEntry[];
}
/**
 * This interface was referenced by `WorkspaceRegistry`'s JSON-Schema
 * via the `definition` "workspaceRegistryEntry".
 */
export interface WorkspaceRegistryEntry {
  id: WorkspaceId;
  /**
   * NFC-normalized absolute filesystem path
   */
  absolutePath: string;
  displayName: string;
  createdAt: string;
  lastOpenedAt: string;
}
