// PTY IPC channel — bridges renderer ↔ main ↔ Go agent host.
// All PTY sessions are routed to the agent host unconditionally.

import { ipcContract } from "../../../shared/ipc/contract";
import type { PtyHostHandle } from "./types";
import { getDefaultShell } from "../../infra/platform/shell";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { TerminalRecorderRegistry, type PtyRecorderSink } from "./recorder";

const c = ipcContract.pty.call;

export interface PtyChannelOptions {
  agentHost: PtyHostHandle;
  recorder?: PtyRecorderSink;
}

/**
 * Registers the renderer PTY IPC channel. Every session is handled by the
 * workspace-scoped Go agent host; the legacy utility process path is gone.
 */
export function registerPtyChannel(options: PtyChannelOptions): void {
  const { agentHost } = options;
  const recorder = options.recorder ?? new TerminalRecorderRegistry();

  agentHost.on("data", (args) => {
    const { workspaceId, tabId, chunk } = args as {
      workspaceId: string;
      tabId: string;
      chunk: string;
    };
    recorder.appendData(workspaceId, tabId, chunk);
    broadcast("pty", "data", { workspaceId, tabId, chunk });
  });

  agentHost.on("exit", (args) => {
    const { workspaceId, tabId, code } = args as {
      workspaceId: string;
      tabId: string;
      code: number | null;
    };
    broadcast("pty", "exit", { workspaceId, tabId, code });
    recorder.stop(workspaceId, tabId);
  });

  register("pty", {
    call: {
      spawn: async (args: unknown) => {
        const { workspaceId, tabId, cwd, cols, rows, env } = validateArgs(c.spawn.args, args);
        recorder.start(workspaceId, tabId, cols, rows);
        const shell = getDefaultShell();
        try {
          const result = await agentHost.call("spawn", {
            workspaceId,
            tabId,
            cwd,
            shell,
            cols,
            rows,
            env,
          });
          return result as { pid: number };
        } catch (error) {
          recorder.stop(workspaceId, tabId);
          throw error;
        }
      },

      write: (args: unknown) => {
        const { workspaceId, tabId, data } = validateArgs(c.write.args, args);
        return agentHost.call("write", { workspaceId, tabId, data });
      },

      resize: (args: unknown) => {
        const { workspaceId, tabId, cols, rows } = validateArgs(c.resize.args, args);
        return agentHost.call("resize", { workspaceId, tabId, cols, rows }).then((value) => {
          recorder.handleResize(workspaceId, tabId, cols, rows);
          return value;
        });
      },

      ack: (args: unknown) => {
        const { workspaceId, tabId, bytesConsumed } = validateArgs(c.ack.args, args);
        return agentHost.call("ack", { workspaceId, tabId, bytesConsumed });
      },

      kill: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.kill.args, args);
        return agentHost.call("kill", { workspaceId, tabId });
      },
    },
    listen: {
      data: {},
      exit: {},
    },
  });
}
