// PTY IPC channel — bridges renderer ↔ main ↔ Go agent host.
// All PTY sessions are routed to the agent host unconditionally.

import { ipcContract } from "../../../shared/ipc/contract";
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import type { WorkspacePorts } from "../../../shared/pty/ports";
import type { CustomShell, ShellChoice } from "../../../shared/pty/shell";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { getActiveAppWindow, getFocusedAppWindow } from "../window/app-windows";
import type { HookInfo } from "../workspace/manager";
import { ForwardError, type PortForwards } from "./forwards";
import { injectHarnessTerminalEnv } from "./harness-env";
import type { WorkspaceNameLookup } from "./osc-notification";
import { OscNotificationDispatcher } from "./osc-notification";
import type { PtyRecorderSink } from "./recorder";
import { applyShellPathShim } from "./shell-shim";
import {
  detectShells,
  findShellProgram,
  nodeShellHost,
  resolveShellChoice,
  type ShellHost,
  systemDefaultShell,
} from "./shells";
import type { PtyHostHandle } from "./types";
import { applyWindowsShellShim, type WindowsAgentFiles } from "./windows-shell-shim";

const c = ipcContract.pty.call;

export interface PtyChannelOptions {
  agentHost: PtyHostHandle;
  recorder?: PtyRecorderSink;
  /**
   * Provides workspace display names, activation for OS notifications, and
   * Pull-based hookserver connection info lookup (getHookInfo).
   *
   * `getAgentChannel` is used to guarantee that hookInfo is fresh —
   * the spawn handler awaits it before capturing the env, which forces channel.ready / the hook.getInfo
   * pull to complete before the hookInfo lookup. The returned channel object
   * itself is not used; the call exists only for ready synchronization.
   *
   * `getWrapperBinDir` / `getWrapperAgentBin` — return, by workspace kind,
   * the absolute paths of the wrapper bin directory and the agent binary. When null is returned,
   * the wrapper-related env injection is skipped.
   *
   * `getWrapperShell` — absolute path of the login shell the workspace's PTY will use.
   * Local returns the main process's `$SHELL`; SSH returns the value looked up on the remote
   * during bootstrap. When null is returned, the ZDOTDIR/--rcfile shim is skipped (the PATH prepend
   * still applies through the wrapperBinDir path).
   *
   * `getWrapperShimDir` — absolute path of the directory holding the shim rc files that the
   * workspace's PTY will source. For local it is a local fs path; for SSH it is the remote absolute
   * path the bootstrap uploaded. Null means the shim directory itself cannot be determined,
   * so the shim is skipped.
   */
  workspaceManager?: WorkspaceNameLookup & {
    activate(id: string): Promise<void>;
    getHookInfo(workspaceId: string): HookInfo | null;
    getAgentChannel(workspaceId: string): Promise<unknown>;
    getWrapperBinDir(workspaceId: string): string | null;
    getWrapperAgentBin(workspaceId: string): string | null;
    getWrapperShell(workspaceId: string): string | null;
    getWrapperShimDir(workspaceId: string): string | null;
    /** Whether the workspace runs on this machine; only those take a chosen shell. */
    isLocal?(workspaceId: string): boolean;
  };
  /** The default shell from Settings › Terminal, read at every spawn. */
  getDefaultShell?: () => ShellChoice | undefined;
  /** The shells the user added in Settings › Terminal, read at every spawn. */
  getCustomShells?: () => readonly CustomShell[] | undefined;
  /** Where shells are looked up; tests pass a fake machine. */
  shellHost?: ShellHost;
  /**
   * On Windows, the claude and codex wrappers and claude's hooks file for
   * local terminals, whose shells take the Windows shim instead of the zsh
   * or bash one.
   */
  windowsAgentFiles?: () => Promise<WindowsAgentFiles | null>;
  /** Whether the tab is the one in front, for a program's OS notifications. */
  isActiveTab?: (workspaceId: string, tabId: string) => boolean;
  /** Settings' OS notifications toggle. */
  notificationsEnabled?: () => boolean;
  /** Input written to a terminal, before it reaches the program. */
  onInput?: (workspaceId: string, tabId: string, data: string) => void;
  /** The ports the programs in the workspaces' terminals listen on. */
  ports?: { snapshot(): WorkspacePorts[] };
  /** The SSH workspaces' ports forwarded to this machine. */
  forwards?: PortForwards;
}

const NO_RECORDER: PtyRecorderSink = {
  start() {},
  appendData() {},
  handleResize() {},
  stop() {},
};

/**
 * Registers the renderer PTY IPC channel. Every session is handled by the
 * workspace-scoped Go agent host; the legacy utility process path is gone.
 */
export function registerPtyChannel(options: PtyChannelOptions): void {
  const { agentHost } = options;
  // Nothing reads a main-side recording yet (the agent keeps the replay
  // buffer), so by default output is not kept here: a recorder held up to
  // 10 MB per terminal for no reader.
  const recorder = options.recorder ?? NO_RECORDER;
  const wm = options.workspaceManager;
  // The shell each local session started with, keyed by workspace and tab,
  // so a tab that reconnects to its running session reports that shell.
  const sessionShellPaths = new Map<string, string>();
  const sessionKey = (workspaceId: string, tabId: string) => `${workspaceId}:${tabId}`;
  const dispatcher = new OscNotificationDispatcher({
    workspaceManager: wm ?? { getName: () => null },
    getFocusedWindow: getFocusedAppWindow,
    isActiveTab: options.isActiveTab,
    notificationsEnabled: options.notificationsEnabled,
    activateWorkspace: wm ? (id) => wm.activate(id) : undefined,
    focusMainWindow: () => {
      const win = getActiveAppWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  });

  agentHost.on("data", (args) => {
    const { workspaceId, tabId, chunk, replay } = args as {
      workspaceId: string;
      tabId: string;
      chunk: string;
      replay?: boolean;
    };
    recorder.appendData(workspaceId, tabId, chunk);
    // Replayed output raised its notifications when it first arrived.
    if (!replay) dispatcher.handleChunk(workspaceId, tabId, chunk);
    broadcast(
      "pty",
      "data",
      replay ? { workspaceId, tabId, chunk, replay } : { workspaceId, tabId, chunk },
    );
  });

  agentHost.on("exit", (args) => {
    const { workspaceId, tabId, code } = args as {
      workspaceId: string;
      tabId: string;
      code: number | null;
    };
    broadcast("pty", "exit", { workspaceId, tabId, code });
    recorder.stop(workspaceId, tabId);
    sessionShellPaths.delete(sessionKey(workspaceId, tabId));
  });

  agentHost.on("held", (args) => {
    const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
    broadcast("pty", "held", { workspaceId, tabId });
  });

  agentHost.on("restored", (args) => {
    const { workspaceId, tabId, withReplay } = args as {
      workspaceId: string;
      tabId: string;
      withReplay: boolean;
    };
    broadcast("pty", "restored", { workspaceId, tabId, withReplay });
  });

  agentHost.on("expired", (args) => {
    const { workspaceId, tabId } = args as { workspaceId: string; tabId: string };
    broadcast("pty", "expired", { workspaceId, tabId });
  });

  register("pty", {
    call: {
      spawn: async (args: unknown) => {
        const {
          workspaceId,
          tabId,
          cwd,
          cols,
          rows,
          env,
          args: spawnArgs,
          shell: tabShell,
        } = validateArgs(c.spawn.args, args);
        recorder.start(workspaceId, tabId, cols, rows);
        // hookInfo must be read after channel.ready for it to be guaranteed fresh.
        // Called right after a channel reconnect, a stale cache (the previous boot's socket path)
        // could be baked into the env, creating a hook client that points at a dead socket.
        // wm.getAgentChannel triggers ensureProviderReady, and at its end the hook.getInfo
        // result is set in hookInfoByWorkspace, so a getHookInfo after this await is
        // structurally guaranteed to be the latest. The returned channel object is not used.
        if (wm) {
          await wm.getAgentChannel(workspaceId);
        }
        // Look up the socket/token by pull with workspaceManager.getHookInfo and inject them into the env.
        const hookInfo = wm?.getHookInfo(workspaceId) ?? null;
        // Decide the wrapper bin directory and agent binary path by workspace kind.
        // When null, skip the wrapper-related env injection (keeps the graceful pattern).
        const wrapperBinDir = wm?.getWrapperBinDir(workspaceId) ?? null;
        const wrapperAgentBin = wm?.getWrapperAgentBin(workspaceId) ?? null;
        let enrichedEnv =
          wrapperBinDir !== null
            ? injectHarnessTerminalEnv(env, {
                binDir: wrapperBinDir,
                workspaceId,
                tabId,
                agentBin: wrapperAgentBin ?? undefined,
                agentSocket: hookInfo?.socketPath,
                hookToken: hookInfo?.token,
              })
            : injectHarnessTerminalEnv(env);

        // Shell shim activation: requires three things from WorkspaceManager.
        //   1. wrapperBinDir   — the bin directory whose contents the shim
        //                        re-prepends to PATH on every prompt.
        //   2. wrapperShell    — the actual login shell that will run on the
        //                        target host (local `$SHELL`, or the
        //                        bootstrap-cached remote `$SHELL`). Without
        //                        it `applyShellPathShim` cannot pick the
        //                        right activation strategy (ZDOTDIR vs
        //                        --rcfile), so we skip.
        //   3. wrapperShimDir  — the directory that actually contains the
        //                        `.zshrc`/`.zshenv`/`bashrc` shim files on
        //                        the host where the spawned shell runs.
        //                        For local workspaces this is a local fs
        //                        path; for SSH workspaces it is the remote
        //                        absolute path that the SSH bootstrap
        //                        uploaded the shim files into.
        //
        // When any of the three is missing, the agent still puts
        // NEXUS_WRAPPER_SELF_DIR first on PATH at spawn (just not
        // re-prepended on every prompt). This is the safe degraded mode —
        // wrapper still wins on a clean rc, only loses ground when the user
        // rc explicitly reorders PATH.
        // A local terminal runs the tab's shell, else the default shell from
        // the settings, else the system default (left to the agent). One
        // that can't be found falls back to the next, and the renderer says
        // so.
        let shell: { path: string; args: string[] } | undefined;
        let shellPath: string | undefined;
        let missingShell: string | undefined;
        if (wm?.isLocal?.(workspaceId)) {
          const host = options.shellHost ?? nodeShellHost();
          const customShells = options.getCustomShells?.();
          for (const choice of [tabShell, options.getDefaultShell?.()]) {
            if (choice === undefined) continue;
            const resolved = resolveShellChoice(host, choice, customShells);
            if ("shell" in resolved) {
              shell = resolved.shell;
              break;
            }
            missingShell ??= resolved.missing;
          }
          shellPath = shell?.path ?? systemDefaultShell(host).path;
        }

        let shimmedArgs: string[] | undefined = shell?.args ?? spawnArgs;
        if (wrapperBinDir !== null && options.windowsAgentFiles && shellPath !== undefined) {
          const files = await options.windowsAgentFiles();
          const shimResult = applyWindowsShellShim({
            shell: shellPath,
            env: enrichedEnv,
            args: shimmedArgs,
            settingsPath: files?.settingsPath,
            wrapperDir: files?.binDir,
            ...(files ? { codex: { cmd: files.cmdCodexNoDaemon } } : {}),
            // A local agent, and so the shell, inherits this process's environment.
            originalPath: process.env.ORIGINAL_PATH,
          });
          enrichedEnv = shimResult.env;
          shimmedArgs = shimResult.args;
          // The arguments are for this shell: name it rather than leave the
          // choice to the agent.
          shell ??= { path: shellPath, args: [] };
        } else if (wrapperBinDir !== null) {
          // The shim's activation (ZDOTDIR for zsh, --rcfile for bash) has
          // to match the shell that actually starts.
          const wrapperShell = shell?.path ?? wm?.getWrapperShell(workspaceId) ?? null;
          const wrapperShimDir = wm?.getWrapperShimDir(workspaceId) ?? null;
          if (wrapperShell !== null && wrapperShimDir !== null) {
            const shimResult = applyShellPathShim({
              shell: wrapperShell,
              env: enrichedEnv,
              args: shimmedArgs,
              shimDir: wrapperShimDir,
            });
            enrichedEnv = shimResult.env;
            shimmedArgs = shimResult.args;
          }
        }

        try {
          // Without a chosen shell the agent resolves one on its own host —
          // for a remote workspace that is the SSH host, not this machine.
          // Sending a shell from here would force the local macOS shell
          // onto a remote that may not have it.
          const result = (await agentHost.call("spawn", {
            workspaceId,
            tabId,
            cwd,
            cols,
            rows,
            env: enrichedEnv,
            ...(shell !== undefined ? { shell: shell.path } : {}),
            ...(shimmedArgs !== undefined && shimmedArgs.length > 0 ? { args: shimmedArgs } : {}),
          })) as { pid: number; attached?: boolean };
          const key = sessionKey(workspaceId, tabId);
          if (result.attached) {
            // The tab reconnected to the shell it already runs, which the
            // settings may no longer name: report that one, and no fallback.
            const running = sessionShellPaths.get(key);
            return { pid: result.pid, ...(running !== undefined ? { shellPath: running } : {}) };
          }
          if (shellPath !== undefined) sessionShellPaths.set(key, shellPath);
          return {
            pid: result.pid,
            ...(shellPath !== undefined ? { shellPath } : {}),
            ...(missingShell !== undefined ? { missingShell } : {}),
          };
        } catch (error) {
          recorder.stop(workspaceId, tabId);
          throw error;
        }
      },

      write: async (args: unknown) => {
        const { workspaceId, tabId, data } = validateArgs(c.write.args, args);
        options.onInput?.(workspaceId, tabId, data);
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

      foregroundProcess: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.foregroundProcess.args, args);
        // agentHost.call can return undefined because of a workspace race, so fall back to an empty name.
        // The renderer reads an empty name as "no info" and keeps the existing title.
        const result = (await agentHost.call("foregroundProcess", { workspaceId, tabId })) as
          | { name: string }
          | undefined;
        return ipcOk({ name: result?.name ?? "" });
      },

      listShells: async () => {
        const host = options.shellHost ?? nodeShellHost();
        return ipcOk({ shells: detectShells(host), systemDefault: systemDefaultShell(host) });
      },

      findShell: async (args: unknown) => {
        const { program } = validateArgs(c.findShell.args, args);
        return ipcOk({ path: findShellProgram(options.shellHost ?? nodeShellHost(), program) });
      },

      ports: async () => ipcOk(options.ports?.snapshot() ?? []),

      forwards: async () => ipcOk(options.forwards?.snapshot() ?? []),

      forward: async (args: unknown) => {
        const { workspaceId, port } = validateArgs(c.forward.args, args);
        const forwards = options.forwards;
        if (!forwards) return ipcErr("not-ssh", "ports are not forwarded here");
        try {
          return ipcOk(await forwards.forward(workspaceId, port));
        } catch (error) {
          return forwardFailure(error);
        }
      },

      unforward: async (args: unknown) => {
        const { workspaceId, port } = validateArgs(c.unforward.args, args);
        await options.forwards?.stop(workspaceId, port);
        return ipcOk(undefined);
      },

      localUrl: async (args: unknown) => {
        const { workspaceId, url } = validateArgs(c.localUrl.args, args);
        const forwards = options.forwards;
        if (!forwards) return ipcOk({ url });
        try {
          return ipcOk({ url: await forwards.localUrl(workspaceId, url) });
        } catch (error) {
          return forwardFailure(error);
        }
      },
    },
    listen: {
      ports: {},
      forwards: {},
      data: {},
      exit: {},
      notificationClick: {},
      held: {},
      restored: {},
      expired: {},
    },
  });
}

/** A forward that failed, as the renderer tells it. */
function forwardFailure(error: unknown) {
  if (error instanceof ForwardError) return ipcErr(error.kind, error.reason);
  return ipcErr("failed", (error as Error).message);
}
