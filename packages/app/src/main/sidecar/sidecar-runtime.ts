import type {
  SidecarStartCommand,
  SidecarStartedEvent,
  SidecarStopCommand,
  SidecarStoppedEvent,
} from "../../../../shared/src/contracts/sidecar/sidecar";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export interface SidecarRuntime {
  start(command: SidecarStartCommand): Promise<SidecarStartedEvent>;
  stop(command: SidecarStopCommand): Promise<SidecarStoppedEvent | null>;
  listRunningWorkspaceIds(): WorkspaceId[];
}
