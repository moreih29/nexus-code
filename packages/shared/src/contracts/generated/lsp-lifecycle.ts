/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type LspLifecycleMessage =
  | LspStartServerCommand
  | LspStopServerCommand
  | LspRestartServerCommand
  | LspHealthCheckCommand
  | LspStopAllServersCommand
  | LspServerStartedReply
  | LspServerStartFailedReply
  | LspServerStoppedEvent
  | LspServerHealthReply
  | LspStopAllServersReply;
export type RequestId = string;
export type ServerId = string;
export type LspLanguage = "typescript" | "python" | "go";
export type LspServerStopReason =
  | "document-close"
  | "workspace-close"
  | "app-shutdown"
  | "restart"
  | "sidecar-stop";
export type LspServerState = "running" | "stopped" | "unavailable" | "error";

export interface LspStartServerCommand {
  type: "lsp/lifecycle";
  action: "start_server";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  serverId: ServerId;
  language: LspLanguage;
  command: string;
  args: string[];
  /**
   * NFC-normalized absolute filesystem path
   */
  cwd: string;
  serverName: string;
}
export interface LspStopServerCommand {
  type: "lsp/lifecycle";
  action: "stop_server";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  serverId: ServerId;
  language: LspLanguage;
  serverName: string;
  reason: LspServerStopReason;
}
export interface LspRestartServerCommand {
  type: "lsp/lifecycle";
  action: "restart_server";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  serverId: ServerId;
  language: LspLanguage;
  command: string;
  args: string[];
  /**
   * NFC-normalized absolute filesystem path
   */
  cwd: string;
  serverName: string;
}
export interface LspHealthCheckCommand {
  type: "lsp/lifecycle";
  action: "health_check";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  serverId: ServerId;
}
export interface LspStopAllServersCommand {
  type: "lsp/lifecycle";
  action: "stop_all";
  requestId: RequestId;
  workspaceId?: WorkspaceId;
  reason: LspServerStopReason;
}
export interface LspServerStartedReply {
  type: "lsp/lifecycle";
  action: "server_started";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  serverId: ServerId;
  language: LspLanguage;
  serverName: string;
  pid: number;
}
export interface LspServerStartFailedReply {
  type: "lsp/lifecycle";
  action: "server_start_failed";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  serverId: ServerId;
  language: LspLanguage;
  serverName: string;
  state: "unavailable" | "error";
  message: string;
}
export interface LspServerStoppedEvent {
  type: "lsp/lifecycle";
  action: "server_stopped";
  requestId?: RequestId;
  workspaceId: WorkspaceId;
  serverId: ServerId;
  language: LspLanguage;
  serverName: string;
  reason: LspServerStopReason;
  exitCode: number | null;
  signal: string | null;
  stoppedAt: string;
  message?: string;
}
export interface LspServerHealthReply {
  type: "lsp/lifecycle";
  action: "server_health";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  serverId: ServerId;
  state: LspServerState;
  pid?: number;
  message?: string;
}
export interface LspStopAllServersReply {
  type: "lsp/lifecycle";
  action: "stop_all_stopped";
  requestId: RequestId;
  workspaceId?: WorkspaceId;
  stoppedServerIds: ServerId[];
}
