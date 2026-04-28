import type {
  SidecarStartCommand,
  SidecarStartedEvent,
  SidecarStopCommand,
  SidecarStoppedEvent,
} from "../../../../shared/src/contracts/sidecar/sidecar";
import type { LspServerStopReason } from "../../../../shared/src/contracts/lsp/lsp-sidecar";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export interface SidecarRuntime {
  start(command: SidecarStartCommand): Promise<SidecarStartedEvent>;
  stop(command: SidecarStopCommand): Promise<SidecarStoppedEvent | null>;
  listRunningWorkspaceIds(): WorkspaceId[];
  stopAllLspServers?(reason?: LspServerStopReason): Promise<void>;
}
