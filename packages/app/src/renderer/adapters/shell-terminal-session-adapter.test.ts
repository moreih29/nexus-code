import { describe, expect, test } from "bun:test";

import type { TerminalTabId } from "../../../../shared/src/contracts/terminal-tab";
import {
  createShellTerminalSessionAdapter,
  DEFAULT_TERMINAL_OPEN_COLS,
  DEFAULT_TERMINAL_OPEN_ROWS,
  type TerminalBridgeSessionLike,
} from "./shell-terminal-session-adapter";

describe("createShellTerminalSessionAdapter", () => {
  test("maps open/input/resize/close commands onto TerminalBridge", async () => {
    const calls = {
      open: [] as Array<Record<string, unknown>>,
      input: [] as Array<Record<string, unknown>>,
      resize: [] as Array<Record<string, unknown>>,
      close: [] as Array<Record<string, unknown>>,
    };

    const bridge: TerminalBridgeSessionLike = {
      async open(command) {
        calls.open.push(command);
        return {
          type: "terminal/opened",
          tabId: "tt_ws_alpha_0001" as TerminalTabId,
          workspaceId: "ws_alpha",
          pid: 111,
        };
      },
      async input(command) {
        calls.input.push(command);
      },
      async resize(command) {
        calls.resize.push(command);
      },
      async close(command) {
        calls.close.push(command);
        return {
          type: "terminal/exited",
          tabId: command.tabId,
          workspaceId: "ws_alpha",
          reason: "user-close",
          exitCode: 0,
        };
      },
    };

    const adapter = createShellTerminalSessionAdapter(bridge);

    await expect(adapter.openTab("ws_alpha")).resolves.toEqual({
      tabId: "tt_ws_alpha_0001",
    });

    await adapter.input("tt_ws_alpha_0001", "ls\n");
    await adapter.resize("tt_ws_alpha_0001", 0, -2);
    await adapter.closeTab("tt_ws_alpha_0001");

    expect(calls.open).toEqual([
      {
        type: "terminal/open",
        workspaceId: "ws_alpha",
        cols: DEFAULT_TERMINAL_OPEN_COLS,
        rows: DEFAULT_TERMINAL_OPEN_ROWS,
      },
    ]);
    expect(calls.input).toEqual([
      {
        type: "terminal/input",
        tabId: "tt_ws_alpha_0001",
        data: "ls\n",
      },
    ]);
    expect(calls.resize).toEqual([
      {
        type: "terminal/resize",
        tabId: "tt_ws_alpha_0001",
        cols: 1,
        rows: 1,
      },
    ]);
    expect(calls.close).toEqual([
      {
        type: "terminal/close",
        tabId: "tt_ws_alpha_0001",
        reason: "user-close",
      },
    ]);
  });

  test("supports custom initial dimensions and close reason", async () => {
    const openCalls: Array<Record<string, unknown>> = [];
    const closeCalls: Array<Record<string, unknown>> = [];

    const bridge: TerminalBridgeSessionLike = {
      async open(command) {
        openCalls.push(command);
        return {
          type: "terminal/opened",
          tabId: "tt_ws_beta_0001" as TerminalTabId,
          workspaceId: "ws_beta",
          pid: 222,
        };
      },
      async input(_command) {
        // no-op
      },
      async resize(_command) {
        // no-op
      },
      async close(command) {
        closeCalls.push(command);
        return null;
      },
    };

    const adapter = createShellTerminalSessionAdapter(bridge, {
      initialCols: 180,
      initialRows: 48,
      closeReason: "workspace-close",
    });

    await adapter.openTab("ws_beta");
    await adapter.closeTab("tt_ws_beta_0001");

    expect(openCalls).toEqual([
      {
        type: "terminal/open",
        workspaceId: "ws_beta",
        cols: 180,
        rows: 48,
      },
    ]);
    expect(closeCalls).toEqual([
      {
        type: "terminal/close",
        tabId: "tt_ws_beta_0001",
        reason: "workspace-close",
      },
    ]);
  });
});
