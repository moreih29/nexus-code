import type { Event, Input, WebContents } from "electron";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import type { WorkspaceSidebarState } from "../../../../../shared/src/contracts/workspace/workspace-shell";
import type { WorkspaceSwitchDirection } from "../../../../../shared/src/contracts/workspace/workspace-switching";

type WebContentsBeforeInputListener = (event: Event, input: Input) => void;

export interface WorkspaceKeyboardShortcutWebContents {
  on(channel: "before-input-event", listener: WebContentsBeforeInputListener): void;
  off(channel: "before-input-event", listener: WebContentsBeforeInputListener): void;
}

export interface WorkspaceKeyboardShortcutShellService {
  getSidebarState(): Promise<WorkspaceSidebarState>;
  activateWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceSidebarState>;
}

export interface WorkspaceKeyboardShortcutBridgeOptions {
  webContents: WorkspaceKeyboardShortcutWebContents | WebContents;
  workspaceShellService: WorkspaceKeyboardShortcutShellService;
  onSidebarStateChanged?: (nextState: WorkspaceSidebarState) => void;
}

type WorkspaceKeyboardCommand =
  | {
      type: "workspace/switch-direct-slot";
      slotNumber: number;
    }
  | {
      type: "workspace/switch-cycle";
      direction: WorkspaceSwitchDirection;
    };

export interface WorkspaceKeyboardShortcutBridge {
  dispose(): void;
}

export function registerWorkspaceKeyboardShortcutBridge(
  options: WorkspaceKeyboardShortcutBridgeOptions,
): WorkspaceKeyboardShortcutBridge {
  const beforeInputListener: WebContentsBeforeInputListener = (event, input) => {
    const command = resolveWorkspaceKeyboardCommand(input);
    if (!command) {
      return;
    }

    event.preventDefault();

    void executeWorkspaceKeyboardCommand(options.workspaceShellService, command)
      .then((nextSidebarState) => {
        options.onSidebarStateChanged?.(nextSidebarState);
      })
      .catch((error) => {
        console.error(
          "Workspace keyboard shortcuts: failed to process before-input-event.",
          error,
        );
      });
  };

  options.webContents.on("before-input-event", beforeInputListener);

  return {
    dispose() {
      options.webContents.off("before-input-event", beforeInputListener);
    },
  };
}

export function resolveWorkspaceKeyboardCommand(input: Input): WorkspaceKeyboardCommand | null {
  if (input.type !== "keyDown") {
    return null;
  }

  if (!hasPrimaryModifier(input)) {
    return null;
  }

  if (input.alt) {
    if (isArrowLeft(input)) {
      return {
        type: "workspace/switch-cycle",
        direction: "previous",
      };
    }

    if (isArrowRight(input)) {
      return {
        type: "workspace/switch-cycle",
        direction: "next",
      };
    }

    return null;
  }

  if (input.shift) {
    return null;
  }

  const slotNumber = resolveDirectSlotNumber(input);
  if (slotNumber === null) {
    return null;
  }

  return {
    type: "workspace/switch-direct-slot",
    slotNumber,
  };
}

export async function executeWorkspaceKeyboardCommand(
  workspaceShellService: WorkspaceKeyboardShortcutShellService,
  command: WorkspaceKeyboardCommand,
): Promise<WorkspaceSidebarState> {
  if (command.type === "workspace/switch-direct-slot") {
    return activateDirectSlot(workspaceShellService, command.slotNumber);
  }

  return switchCycle(workspaceShellService, command.direction);
}

async function activateDirectSlot(
  workspaceShellService: WorkspaceKeyboardShortcutShellService,
  slotNumber: number,
): Promise<WorkspaceSidebarState> {
  if (!Number.isInteger(slotNumber) || slotNumber < 1) {
    return workspaceShellService.getSidebarState();
  }

  const sidebarState = await workspaceShellService.getSidebarState();
  const targetWorkspace = sidebarState.openWorkspaces[slotNumber - 1];
  if (!targetWorkspace || targetWorkspace.id === sidebarState.activeWorkspaceId) {
    return sidebarState;
  }

  return workspaceShellService.activateWorkspace(targetWorkspace.id);
}

async function switchCycle(
  workspaceShellService: WorkspaceKeyboardShortcutShellService,
  direction: WorkspaceSwitchDirection,
): Promise<WorkspaceSidebarState> {
  const sidebarState = await workspaceShellService.getSidebarState();
  if (sidebarState.openWorkspaces.length === 0) {
    return sidebarState;
  }

  const activeWorkspaceIndex = sidebarState.openWorkspaces.findIndex(
    (workspace) => workspace.id === sidebarState.activeWorkspaceId,
  );
  const targetWorkspaceIndex = calculateCycleTargetIndex(
    sidebarState.openWorkspaces.length,
    activeWorkspaceIndex,
    direction,
  );
  const targetWorkspace = sidebarState.openWorkspaces[targetWorkspaceIndex];
  if (!targetWorkspace || targetWorkspace.id === sidebarState.activeWorkspaceId) {
    return sidebarState;
  }

  return workspaceShellService.activateWorkspace(targetWorkspace.id);
}

function calculateCycleTargetIndex(
  workspaceCount: number,
  activeWorkspaceIndex: number,
  direction: WorkspaceSwitchDirection,
): number {
  if (workspaceCount <= 0) {
    return 0;
  }

  if (activeWorkspaceIndex < 0) {
    return direction === "next" ? 0 : workspaceCount - 1;
  }

  const delta = direction === "next" ? 1 : -1;
  return (activeWorkspaceIndex + delta + workspaceCount) % workspaceCount;
}

function hasPrimaryModifier(input: Input): boolean {
  if (process.platform === "darwin") {
    return input.meta;
  }

  return input.control;
}

function resolveDirectSlotNumber(input: Input): number | null {
  if (isDigitCharacter(input.key)) {
    return Number(input.key);
  }

  if (typeof input.code === "string") {
    const digitCodeMatch = /^Digit([1-9])$/.exec(input.code);
    if (digitCodeMatch) {
      return Number(digitCodeMatch[1]);
    }

    const numpadCodeMatch = /^Numpad([1-9])$/.exec(input.code);
    if (numpadCodeMatch) {
      return Number(numpadCodeMatch[1]);
    }
  }

  return null;
}

function isDigitCharacter(candidate: string): candidate is `${number}` {
  return /^[1-9]$/.test(candidate);
}

function isArrowLeft(input: Input): boolean {
  return input.key === "ArrowLeft" || input.code === "ArrowLeft";
}

function isArrowRight(input: Input): boolean {
  return input.key === "ArrowRight" || input.code === "ArrowRight";
}
