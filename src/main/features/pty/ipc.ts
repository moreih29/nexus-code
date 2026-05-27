// PTY IPC channel — bridges renderer ↔ main ↔ Go agent host.
// All PTY sessions are routed to the agent host unconditionally.

import { ipcContract } from "../../../shared/ipc/contract";
import type { PtyHostHandle } from "./types";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { TerminalRecorderRegistry, type PtyRecorderSink } from "./recorder";
import { ipcOk } from "../../../shared/ipc/result";
import { injectHarnessTerminalEnv } from "./harness-env";
import { applyShellPathShim } from "./shell-shim";
import { OscNotificationDispatcher } from "./osc-notification";
import type { WorkspaceNameLookup } from "./osc-notification";
import type { HookInfo } from "../workspace/manager";

const c = ipcContract.pty.call;

export interface PtyChannelOptions {
  agentHost: PtyHostHandle;
  recorder?: PtyRecorderSink;
  /**
   * Provides workspace display names, activation for OS notifications, and
   * pull 기반 hookserver 접속 정보 조회(getHookInfo).
   *
   * `getAgentChannel`은 hookInfo가 fresh함을 보장하기 위해 사용된다 —
   * spawn 핸들러가 env를 캡처하기 전에 await하여 channel.ready / hook.getInfo
   * pull 완료 시점이 hookInfo 조회보다 앞서도록 강제한다. 반환 채널 객체
   * 자체는 사용하지 않고 ready 동기화 목적으로만 호출한다.
   *
   * `getWrapperBinDir` / `getWrapperAgentBin` — 워크스페이스 종류에 따라
   * 래퍼 bin 디렉터리와 agent 바이너리 절대 경로를 반환한다. null 반환 시
   * wrapper 관련 env 주입을 skip한다.
   *
   * `getWrapperShell` — 해당 워크스페이스의 PTY가 사용할 로그인 셸의 절대 경로.
   * 로컬은 main process의 `$SHELL`, SSH는 부트스트랩 시 remote에서 조회한 값을
   * 돌려준다. null 반환 시 ZDOTDIR/--rcfile 셤 적용을 skip한다(PATH prepend는
   * wrapperBinDir 경로로 그대로 적용됨).
   *
   * `getWrapperShimDir` — 그 워크스페이스의 PTY가 source할 끼움 rc 파일들이
   * 놓인 디렉터리의 절대 경로. 로컬이면 로컬 fs 경로, SSH면 부트스트랩이 원격에
   * 업로드해둔 원격 절대 경로. null이면 셤 디렉터리 자체를 결정할 수 없음을
   * 뜻하며 셤 적용을 skip한다.
   */
  workspaceManager?: WorkspaceNameLookup & {
    activate(id: string): Promise<void>;
    getHookInfo(workspaceId: string): HookInfo | null;
    getAgentChannel(workspaceId: string): Promise<unknown>;
    getWrapperBinDir(workspaceId: string): string | null;
    getWrapperAgentBin(workspaceId: string): string | null;
    getWrapperShell(workspaceId: string): string | null;
    getWrapperShimDir(workspaceId: string): string | null;
  };
}

/**
 * Registers the renderer PTY IPC channel. Every session is handled by the
 * workspace-scoped Go agent host; the legacy utility process path is gone.
 */
export function registerPtyChannel(options: PtyChannelOptions): void {
  const { agentHost } = options;
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
        const { workspaceId, tabId, cwd, cols, rows, env, args: spawnArgs } = validateArgs(
          c.spawn.args,
          args,
        );
        recorder.start(workspaceId, tabId, cols, rows);
        // hookInfo는 반드시 channel.ready 이후에 읽어야 fresh가 보장된다.
        // channel reconnect 직후 호출 시 stale 캐시(이전 boot의 socket path)가
        // env에 박혀 죽은 소켓으로 향하는 hook 클라이언트가 생성될 수 있다.
        // wm.getAgentChannel은 ensureProviderReady를 트리거하며 그 끝에 hook.getInfo
        // 결과가 hookInfoByWorkspace에 셋팅되므로, 이 await 이후의 getHookInfo는
        // 최신 값임을 구조적으로 보장한다. 반환 채널 객체는 사용하지 않는다.
        if (wm) {
          await wm.getAgentChannel(workspaceId);
        }
        // workspaceManager.getHookInfo로 pull 기반 소켓/토큰 조회 후 env에 주입한다.
        const hookInfo = wm?.getHookInfo(workspaceId) ?? null;
        // wrapper bin 디렉터리와 agent 바이너리 경로를 워크스페이스 종류에 따라 결정한다.
        // null이면 wrapper 관련 env 주입을 skip (graceful 패턴 유지).
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
        // When any of the three is missing, PATH prepend has already run
        // above so the wrapper bin still appears in PATH (just not
        // re-prepended on every prompt). This is the safe degraded mode —
        // wrapper still wins on a clean rc, only loses ground when the user
        // rc explicitly reorders PATH.
        let shimmedArgs: string[] | undefined = spawnArgs;
        if (wrapperBinDir !== null) {
          const wrapperShell = wm?.getWrapperShell(workspaceId) ?? null;
          const wrapperShimDir = wm?.getWrapperShimDir(workspaceId) ?? null;
          if (wrapperShell !== null && wrapperShimDir !== null) {
            const shimResult = applyShellPathShim({
              shell: wrapperShell,
              env: enrichedEnv,
              args: spawnArgs,
              shimDir: wrapperShimDir,
            });
            enrichedEnv = shimResult.env;
            shimmedArgs = shimResult.args;
          }
        }

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
            ...(shimmedArgs !== undefined ? { args: shimmedArgs } : {}),
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

      foregroundProcess: async (args: unknown) => {
        const { workspaceId, tabId } = validateArgs(c.foregroundProcess.args, args);
        // agentHost.call이 워크스페이스 race로 undefined를 반환할 수 있어 빈 이름으로 fallback.
        // renderer는 빈 이름을 "정보 없음"으로 해석해 기존 title을 유지한다.
        const result = (await agentHost.call("foregroundProcess", { workspaceId, tabId })) as
          | { name: string }
          | undefined;
        return ipcOk({ name: result?.name ?? "" });
      },
    },
    listen: {
      data: {},
      exit: {},
      notificationClick: {},
    },
  });
}
