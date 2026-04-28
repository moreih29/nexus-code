/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type LspRelayMessage = LspClientPayloadMessage | LspServerPayloadMessage;
export type ServerId = string;

export interface LspClientPayloadMessage {
  type: "lsp/relay";
  direction: "client_to_server";
  workspaceId: WorkspaceId;
  serverId: ServerId;
  seq: number;
  /**
   * Opaque UTF-8 LSP JSON-RPC stdio frame chunk
   */
  payload: string;
}
export interface LspServerPayloadMessage {
  type: "lsp/relay";
  direction: "server_to_client";
  workspaceId: WorkspaceId;
  serverId: ServerId;
  seq: number;
  /**
   * Opaque UTF-8 LSP JSON-RPC stdio frame chunk
   */
  payload: string;
}
