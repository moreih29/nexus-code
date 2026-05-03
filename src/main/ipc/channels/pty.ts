// PTY IPC channel — bridges renderer ↔ main ↔ utility(pty-host).
// Renderer calls are forwarded to the pty host via the PtyHostHandle.
// Utility events are broadcast to all renderers.

import { ipcContract } from "../../../shared/ipc-contract";
import type { PtyHostHandle } from "../../hosts/pty-host";
import { getDefaultShell } from "../../platform/shell";
import { broadcast, register, validateArgs } from "../router";

const c = ipcContract.pty.call;

export function registerPtyChannel(ptyHost: PtyHostHandle): void {
  // Forward utility→main events to renderers
  ptyHost.on("data", (args) => {
    const { tabId, chunk } = args as { tabId: string; chunk: string };
    broadcast("pty", "data", { tabId, chunk });
  });

  ptyHost.on("exit", (args) => {
    const { tabId, code } = args as { tabId: string; code: number | null };
    broadcast("pty", "exit", { tabId, code });
  });

  register("pty", {
    call: {
      spawn: async (args: unknown) => {
        const { tabId, cwd, cols, rows } = validateArgs(c.spawn.args, args);
        const shell = getDefaultShell();
        const result = await ptyHost.call("spawn", { tabId, cwd, shell, cols, rows });
        return result as { pid: number };
      },

      write: (args: unknown) => {
        const { tabId, data } = validateArgs(c.write.args, args);
        return ptyHost.call("write", { tabId, data });
      },

      resize: (args: unknown) => {
        const { tabId, cols, rows } = validateArgs(c.resize.args, args);
        return ptyHost.call("resize", { tabId, cols, rows });
      },

      ack: (args: unknown) => {
        const { tabId, bytesConsumed } = validateArgs(c.ack.args, args);
        return ptyHost.call("ack", { tabId, charCount: bytesConsumed });
      },

      kill: (args: unknown) => {
        const { tabId } = validateArgs(c.kill.args, args);
        return ptyHost.call("kill", { tabId });
      },
    },
    listen: {
      data: {},
      exit: {},
    },
  });
}
