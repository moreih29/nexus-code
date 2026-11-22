import type { TerminalOpener } from "../../../shared/chat/relay";
import type { ShellChoice } from "../../../shared/pty/shell";
import type { AnsiScreen } from "./buffer-ansi";

export interface TerminalInput {
  openedBy?: TerminalOpener;
  workspaceId: string;
  cwd: string;
  /** The shell to open with; absent = the default shell setting. */
  shell?: ShellChoice;
  /** An agent profile, by id: the shell runs with what a chat of it runs with. */
  profile?: string;
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
  profile?: string;
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
  profile?: string;
  container: HTMLElement;
  autoSpawn?: boolean;
  onExit?: (args: { code: number | null }) => void;
}

/** A new snapshot for each interaction that may change the terminal input. */
export interface TerminalInputCheckpoint {
  readonly hasInput: boolean;
}

export interface TerminalController {
  /** Identity of the current shell for sandbox consent. Replaced when a new shell starts. */
  readonly sandboxSession: string | null;
  /**
   * Re-rasterize the visible viewport from xterm's in-memory line buffer.
   * Call after the underlying DOM container is moved (e.g. createPortal
   * target swap when a tab is dragged into another group) — WebGL/Canvas
   * renderer addons can lose their rasterized buffer in transit, leaving
   * a black viewport until the next data arrives.
   */
  refresh: () => void;
  /**
   * Focus the terminal, or do so once it has opened if it has not yet and
   * `wanted` (asked then) still says so.
   */
  focus: (wanted?: () => boolean) => void;
  /**
   * The last `lines` lines it shows, scrollback included, as plain text;
   * with `ansi`, with their colors and styles as SGR escapes.
   */
  readText: (lines: number, ansi?: boolean) => string;
  /**
   * The last `lines` lines as readText with `ansi` gives them, and where the
   * cursor is in them, unless the program hid it.
   */
  readScreen: (lines: number) => AnsiScreen;
  /**
   * Types `text` into the session: as one paste, which an app that turned on
   * bracketed paste takes as a whole, or as keystrokes. False before the
   * terminal has opened.
   */
  input: (text: string, mode: "paste" | "keys") => boolean;
  getInputCheckpoint: () => TerminalInputCheckpoint;
  onInput: (listener: () => void) => () => void;
  /**
   * True once input reaches its shell: it has opened (after its view
   * registers it, once its fonts have loaded) and its shell has started,
   * printing its prompt and going quiet (PowerShell drops what comes
   * before), or it prints nothing for a while; false after `timeoutMs` if
   * not, or once it is gone.
   */
  whenReady: (timeoutMs: number) => Promise<boolean>;
  /**
   * True once the program next writes output, other than replayed
   * scrollback; false after `timeoutMs` without any, or once the terminal
   * is gone.
   */
  nextOutput: (timeoutMs: number) => Promise<boolean>;
  /**
   * Calls `listener` each time the program's output (not replayed
   * scrollback) is on the terminal, and once with true when the terminal
   * is gone. Returns its removal.
   */
  onOutput: (listener: (ended: boolean) => void) => () => void;
  /**
   * Whether the app in the session turned on bracketed paste, so a pasted
   * line break stays in the paste instead of acting as Enter.
   */
  bracketedPaste: () => boolean;
  reopen: () => Promise<void>;
  dispose: () => void;
}
