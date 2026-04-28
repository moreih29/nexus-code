/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type LspRelayMessage = LspClientPayloadMessage | LspServerPayloadMessage;
export type ServerId = string;
/**
 * RFC 6455 WebSocket close code observed on the sidecar channel
 */
export type WebSocketCloseCode = number;
/**
 * Close codes that the main process should treat as graceful for this relay path
 *
 * @minItems 1
 */
export type ExpectedCloseCodes = [WebSocketCloseCode, ...WebSocketCloseCode[]];

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
  closeCode?: WebSocketCloseCode;
  expectedCloseCodes?: ExpectedCloseCodes;
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
  closeCode?: WebSocketCloseCode;
  expectedCloseCodes?: ExpectedCloseCodes;
}
