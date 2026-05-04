export interface TerminalInput {
  workspaceId: string;
  cwd: string;
}

export interface TerminalTabLocation {
  groupId: string;
  tabId: string;
}

export interface OpenTerminalOptions {
  groupId?: string | "active";
  newSplit?: {
    orientation: "horizontal" | "vertical";
    side: "before" | "after";
  };
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface PtyClientOptions {
  tabId: string;
  cwd: string;
  onData: (chunk: string) => void;
  onExit: (args: { code: number | null }) => void;
}

export interface PtyClient {
  spawn: (dimensions: TerminalDimensions) => Promise<{ pid: number } | null>;
  write: (data: string) => void;
  resize: (dimensions: TerminalDimensions) => void;
  dispose: () => void;
}

export interface TerminalControllerOptions {
  tabId: string;
  cwd: string;
  container: HTMLElement;
}

export interface TerminalController {
  dispose: () => void;
}
