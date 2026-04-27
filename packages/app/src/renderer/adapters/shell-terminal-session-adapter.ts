import type {
  TerminalCloseCommand,
  TerminalInputCommand,
  TerminalOpenCommand,
  TerminalResizeCommand,
} from "../../../../shared/src/contracts/terminal/terminal-ipc";
import type { TerminalCloseReason } from "../../../../shared/src/contracts/terminal/terminal-lifecycle";
import type { TerminalTabId } from "../../../../shared/src/contracts/terminal/terminal-tab";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { ShellTerminalSessionAdapter } from "../terminal/shell-terminal-tab";

export const DEFAULT_TERMINAL_OPEN_COLS = 120;
export const DEFAULT_TERMINAL_OPEN_ROWS = 30;

export interface ShellTerminalSessionAdapterOptions {
  initialCols?: number;
  initialRows?: number;
  closeReason?: TerminalCloseReason;
}

export interface TerminalBridgeSessionLike {
  open(command: TerminalOpenCommand): Promise<{ tabId: TerminalTabId }>;
  input(command: TerminalInputCommand): Promise<void>;
  resize(command: TerminalResizeCommand): Promise<void>;
  close(command: TerminalCloseCommand): Promise<unknown>;
}

const DEFAULT_CLOSE_REASON: TerminalCloseReason = "user-close";

export function createShellTerminalSessionAdapter(
  bridge: TerminalBridgeSessionLike,
  options: ShellTerminalSessionAdapterOptions = {},
): ShellTerminalSessionAdapter {
  const initialCols = normalizePositiveInteger(options.initialCols, DEFAULT_TERMINAL_OPEN_COLS);
  const initialRows = normalizePositiveInteger(options.initialRows, DEFAULT_TERMINAL_OPEN_ROWS);
  const closeReason = options.closeReason ?? DEFAULT_CLOSE_REASON;

  return {
    async openTab(workspaceId: WorkspaceId): Promise<{ tabId: TerminalTabId }> {
      const opened = await bridge.open({
        type: "terminal/open",
        workspaceId,
        cols: initialCols,
        rows: initialRows,
      });

      return {
        tabId: opened.tabId,
      };
    },
    async closeTab(tabId): Promise<void> {
      await bridge.close({
        type: "terminal/close",
        tabId,
        reason: closeReason,
      });
    },
    async input(tabId, data): Promise<void> {
      await bridge.input({
        type: "terminal/input",
        tabId,
        data,
      });
    },
    async resize(tabId, cols, rows): Promise<void> {
      await bridge.resize({
        type: "terminal/resize",
        tabId,
        cols: normalizePositiveInteger(cols, 1),
        rows: normalizePositiveInteger(rows, 1),
      });
    },
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}
