import type { ShellChoice } from "../../../shared/pty/shell";

export interface TerminalInput {
  workspaceId: string;
  cwd: string;
  /** The shell to open with; absent = the default shell setting. */
  shell?: ShellChoice;
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
  shell?: ShellChoice;
  /**
   * `replay` marks output the agent sends again to redraw the terminal (after
   * a reattach, or for a session that outlived the app or its window).
   */
  onData: (chunk: string, replay: boolean) => void;
  onExit: (args: { code: number | null }) => void;
}

/** What a spawn reports back; the shell fields come from main (local workspaces). */
export interface SpawnedSession {
  pid: number;
  /** The shell that started. */
  shellPath?: string;
  /** The chosen shell that couldn't be found; the system default ran instead. */
  missingShell?: string;
}

export interface PtyClient {
  spawn: (dimensions: TerminalDimensions) => Promise<SpawnedSession | null>;
  write: (data: string) => void;
  resize: (dimensions: TerminalDimensions) => void;
  dispose: () => void;
}

export interface TerminalControllerOptions {
  workspaceId: string;
  tabId: string;
  cwd: string;
  shell?: ShellChoice;
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
  /** Focus the terminal, or do so once it has opened if it has not yet. */
  focus: () => void;
  /** The last `lines` lines it shows, scrollback included, as plain text. */
  readText: (lines: number) => string;
  /**
   * Types `text` into the session: as one paste, which an app that turned on
   * bracketed paste takes as a whole, or as keystrokes. False before the
   * terminal has opened.
   */
  input: (text: string, mode: "paste" | "keys") => boolean;
  reopen: () => Promise<void>;
  dispose: () => void;
}
