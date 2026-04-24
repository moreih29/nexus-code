import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import type { WorkspaceSidebarState } from "../../../shared/src/contracts/workspace-shell";
import type {
  WorkspaceSwitchCommand,
  WorkspaceSwitchDirection,
} from "../../../shared/src/contracts/workspace-switching";

export interface WorkspaceSwitchingModel {
  getSidebarState(): WorkspaceSidebarState;
  activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
}

export class WorkspaceSwitchingCommands {
  public constructor(private readonly model: WorkspaceSwitchingModel) {}

  public execute(command: WorkspaceSwitchCommand): Promise<WorkspaceSidebarState> {
    if (command.type === "workspace/switch-cycle") {
      return this.switchCycle(command.direction);
    }

    return this.activateDirectSlot(command.slotNumber);
  }

  public switchPrevious(): Promise<WorkspaceSidebarState> {
    return this.switchCycle("previous");
  }

  public switchNext(): Promise<WorkspaceSidebarState> {
    return this.switchCycle("next");
  }

  public async activateDirectSlot(slotNumber: number): Promise<WorkspaceSidebarState> {
    return activateWorkspaceSlot(this.model, slotNumber);
  }

  private async switchCycle(direction: WorkspaceSwitchDirection): Promise<WorkspaceSidebarState> {
    return switchWorkspaceCycle(this.model, direction);
  }
}

export async function activateWorkspaceSlot(
  model: WorkspaceSwitchingModel,
  slotNumber: number,
): Promise<WorkspaceSidebarState> {
  if (!Number.isInteger(slotNumber) || slotNumber < 1) {
    return model.getSidebarState();
  }

  const sidebarState = model.getSidebarState();
  const workspace = sidebarState.openWorkspaces[slotNumber - 1];
  if (!workspace) {
    return sidebarState;
  }

  return model.activateWorkspace(workspace.id);
}

export async function switchWorkspaceCycle(
  model: WorkspaceSwitchingModel,
  direction: WorkspaceSwitchDirection,
): Promise<WorkspaceSidebarState> {
  const sidebarState = model.getSidebarState();
  const openWorkspaces = sidebarState.openWorkspaces;
  if (openWorkspaces.length === 0) {
    return sidebarState;
  }

  const activeIndex = openWorkspaces.findIndex(
    (workspace) => workspace.id === sidebarState.activeWorkspaceId,
  );
  const targetIndex = calculateTargetIndex(openWorkspaces.length, activeIndex, direction);
  return model.activateWorkspace(openWorkspaces[targetIndex]!.id);
}

function calculateTargetIndex(
  count: number,
  activeIndex: number,
  direction: WorkspaceSwitchDirection,
): number {
  if (count <= 0) {
    return 0;
  }

  if (activeIndex < 0) {
    return direction === "next" ? 0 : count - 1;
  }

  const delta = direction === "next" ? 1 : -1;
  return (activeIndex + delta + count) % count;
}
