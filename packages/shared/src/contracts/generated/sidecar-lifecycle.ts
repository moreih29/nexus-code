/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type SidecarLifecycleMessage =
  | SidecarStartCommand
  | SidecarStartedEvent
  | SidecarStopCommand
  | SidecarStoppedEvent;
export type SidecarStartReason = "workspace-open" | "session-restore";
export type SidecarStopReason = "workspace-close" | "app-shutdown";
export type SidecarStoppedReason = "requested" | "process-exit" | "process-crash";

export interface SidecarStartCommand {
  type: "sidecar/start";
  workspaceId: WorkspaceId;
  /**
   * NFC-normalized absolute filesystem path
   */
  workspacePath: string;
  reason: SidecarStartReason;
}
export interface SidecarStartedEvent {
  type: "sidecar/started";
  workspaceId: WorkspaceId;
  pid: number;
  startedAt: string;
}
export interface SidecarStopCommand {
  type: "sidecar/stop";
  workspaceId: WorkspaceId;
  reason: SidecarStopReason;
}
export interface SidecarStoppedEvent {
  type: "sidecar/stopped";
  workspaceId: WorkspaceId;
  reason: SidecarStoppedReason;
  stoppedAt: string;
  exitCode: number | null;
}
