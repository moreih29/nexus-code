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
  workspaceId: string;
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
  workspaceId: string;
  tabId: string;
  cwd: string;
  container: HTMLElement;
  autoSpawn?: boolean;
  onExit?: (args: { code: number | null }) => void;
}

export interface TerminalController {
  /**
   * Re-rasterize the visible viewport from xterm's in-memory line buffer.
   * Call after the underlying DOM container is moved (e.g. createPortal
   * target swap when a tab is dragged into another group) — WebGL/Canvas
   * renderer addons can lose their rasterized buffer in transit, leaving
   * a black viewport until the next data arrives.
   */
  refresh: () => void;
  reopen: () => Promise<void>;
  /**
   * Injects `\x1bc` (full terminal reset) into the xterm buffer to clear any
   * stale ANSI mid-sequence garbage before ring-buffer replay data arrives.
   * No-op if the controller is disposed or not yet initialized.
   */
  writeReset: () => void;
  dispose: () => void;
}
