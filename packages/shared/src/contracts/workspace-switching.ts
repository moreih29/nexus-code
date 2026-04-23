export type WorkspaceSwitchDirection = "previous" | "next";

export type WorkspaceSwitchCommand =
  | {
      type: "workspace/switch-cycle";
      direction: WorkspaceSwitchDirection;
    }
  | {
      type: "workspace/switch-direct-slot";
      slotNumber: number;
    };

export interface WorkspaceKeybindingSuggestion {
  command: WorkspaceSwitchCommand["type"];
  accelerator: string;
  status: "placeholder";
  description: string;
}

export const DEFAULT_WORKSPACE_KEYBINDING_SUGGESTIONS: WorkspaceKeybindingSuggestion[] = [
  {
    command: "workspace/switch-cycle",
    accelerator: "Mod+Alt+[",
    status: "placeholder",
    description: "Switch to previous open workspace in sidebar order",
  },
  {
    command: "workspace/switch-cycle",
    accelerator: "Mod+Alt+]",
    status: "placeholder",
    description: "Switch to next open workspace in sidebar order",
  },
  {
    command: "workspace/switch-direct-slot",
    accelerator: "Mod+1..9",
    status: "placeholder",
    description: "Activate direct workspace slot by sidebar index (1-based)",
  },
];
