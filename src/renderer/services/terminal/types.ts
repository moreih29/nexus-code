import type { TerminalOpener } from "../../../shared/chat/relay";
import type { ShellChoice } from "../../../shared/pty/shell";
import type { AnsiScreen } from "./buffer-ansi";

export interface TerminalInput {
  openedBy?: TerminalOpener;
  workspaceId: string;
  cwd: string;
  shell?: ShellChoice;
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
  onData: (chunk: string, replay: boolean) => void;
  onExit: (args: { code: number | null }) => void;
}

export interface SpawnedSession {
  pid: number;
  shellPath?: string;
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

export interface TerminalInputCheckpoint {
  readonly hasInput: boolean;
}

export interface TerminalController {
  readonly sandboxSession: string | null;
  refresh: () => void;
  focus: (wanted?: () => boolean) => void;
  readText: (lines: number, ansi?: boolean) => string;
  readScreen: (lines: number) => AnsiScreen;
  input: (text: string, mode: "paste" | "keys") => boolean;
  getInputCheckpoint: () => TerminalInputCheckpoint;
  onInput: (listener: () => void) => () => void;
  whenReady: (timeoutMs: number) => Promise<boolean>;
  nextOutput: (timeoutMs: number) => Promise<boolean>;
  onOutput: (listener: (ended: boolean) => void) => () => void;
  bracketedPaste: () => boolean;
  reopen: () => Promise<void>;
  dispose: () => void;
}
