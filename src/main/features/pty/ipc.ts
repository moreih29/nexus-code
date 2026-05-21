// PTY IPC channel — bridges renderer ↔ main ↔ Go agent host.
// All PTY sessions are routed to the agent host unconditionally.

import { ipcContract } from "../../../shared/ipc/contract";
import type { PtyHostHandle } from "./types";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { TerminalRecorderRegistry, type PtyRecorderSink } from "./recorder";
import { ipcOk } from "../../../shared/ipc/result";
import { injectHarnessTerminalEnv } from "./harness-env";
import { OscNotificationDispatcher } from "./osc-notification";
import type { WorkspaceNameLookup } from "./osc-notification";
import type { AgentReadyCache } from "../claude/agent-ready-cache";
import { getAgentBinaryPath } from "../../infra/agent/getAgentBinDir";

const c = ipcContract.pty.call;

export interface PtyChannelOptions {
  agentHost: PtyHostHandle;
  recorder?: PtyRecorderSink;
  /** Provides workspace display names and activation for OS notifications. */
  workspaceManager?: WorkspaceNameLookup & { activate(id: string): Promise<void> };
  /**
   * hookserver 접속 정보 캐시 — PTY spawn 시 NEXUS_AGENT_SOCKET / NEXUS_HOOK_TOKEN
   * env에 실제 값을 주입하기 위해 사용한다. 미제공 시 값을 설정하지 않는다.
   */
  hookReadyCache?: AgentReadyCache;
}

/**
 * Registers the renderer PTY IPC channel. Every session is handled by the
 * workspace-scoped Go agent host; the legacy utility process path is gone.
 */
export function registerPtyChannel(options: PtyChannelOptions): void {
  const { agentHost } = options;
  const { hookReadyCache } = options;
  const recorder = options.recorder ?? new TerminalRecorderRegistry();
  const wm = options.workspaceManager;
  // BrowserWindow is accessed lazily (require) to avoid a static electron
  // import that breaks test environments where electron is partially mocked.
  const getElectron = (): typeof import("electron") =>
    require("electron") as typeof import("electron");
  const dispatcher = new OscNotificationDispatcher({
    workspaceManager: wm ?? { getName: () => null },
    getFocusedWindow: () => getElectron().BrowserWindow.getFocusedWindow(),
    activateWorkspace: wm ? (id) => wm.activate(id) : undefined,
    focusMainWindow: () => {
      const win = getElectron().BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  });

  agentHost.on("data", (args) => {
    const { workspaceId, tabId, chunk } = args as {
      workspaceId: string;
      tabId: string;
      chunk: string;
    };
    recorder.appendData(workspaceId, tabId, chunk);
    dispatcher.handleChunk(workspaceId, tabId, chunk);
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
        // hookReadyCache에서 소켓/토큰 조회 후 env에 주입한다.
        const hookInfo = hookReadyCache?.getHookInfo(workspaceId);
        const enrichedEnv = injectHarnessTerminalEnv(env, {
          workspaceId,
          tabId,
          agentBin: getAgentBinaryPath(),
          agentSocket: hookInfo?.socketPath,
          hookToken: hookInfo?.token,
        });
        try {
          // The shell is resolved by the agent on its own host — for a
          // remote workspace that is the SSH host, not this machine.
          // Sending a shell from here would force the local macOS shell
          // onto a remote that may not have it.
          const result = await agentHost.call("spawn", {
            workspaceId,
            tabId,
            cwd,
            cols,
            rows,
            env: enrichedEnv,
          });
          return result as { pid: number };
        } catch (error) {
          recorder.stop(workspaceId, tabId);
          throw error;
        }
      },

      write: async (args: unknown) => {
        const { workspaceId, tabId, data } = validateArgs(c.write.args, args);
        // write/resize/ack/kill are fire-and-forget from the renderer and no-op
        // when the workspace is already gone — agentHost.call returns undefined
        // in that case. Return ipcOk so the router stays silent on either path.
        await agentHost.call("write", { workspaceId, tabId, data });
        return ipcOk(undefined);
      },

      resize: async (args: unknown) => {
        const { workspaceId, tabId, cols, rows } = validateArgs(c.resize.args, args);
        await agentHost.call("resize", { workspaceId, tabId, cols, rows });
        recorder.handleResize(workspaceId, tabId, cols, rows);
        return ipcOk(undefined);
      },

      ack: async (args: unknown) => {
        const { workspaceId, tabId, bytesConsumed } = validateArgs(c.ack.args, args);
        await agentHost.call("ack", { workspaceId, tabId, bytesConsumed });
        return ipcOk(undefined);
      },

      kill: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.kill.args, args);
        // The workspace may already be removed when this arrives from the
        // renderer's workspace-cleanup fan-out. agentHost.call returns
        // undefined (no-op) in that case; ipcOk keeps the router silent.
        await agentHost.call("kill", { workspaceId, tabId });
        return ipcOk(undefined);
      },
    },
    listen: {
      data: {},
      exit: {},
      notificationClick: {},
    },
  });
}
