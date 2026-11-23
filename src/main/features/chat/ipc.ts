// Claude tab IPC channel: renderer ↔ main ↔ the workspace's agent.

import { ipcContract } from "../../../shared/ipc/contract";
import { type IpcResult, ipcErr, ipcOk } from "../../../shared/ipc/result";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { agentCallError } from "../../infra/ipc-router/agent-errors";
import { AgentProfileSelectionError, ChatHost, type ChatHostOptions } from "./host";
import { OAuthCallbacksClosedError } from "./oauth-callback";

const c = ipcContract.chat.call;

/** Surfaces a stale profile as a recoverable error at the IPC boundary. */
function withProfileError<T>(run: (args: unknown) => Promise<IpcResult<T>>) {
  return async (args: unknown): Promise<IpcResult<T>> => {
    try {
      return await run(args);
    } catch (error) {
      if (error instanceof AgentProfileSelectionError) {
        return ipcErr("not-found", error.message, { category: "failed" });
      }
      throw error;
    }
  };
}

export function registerChatChannel(options: Omit<ChatHostOptions, "broadcast">): ChatHost {
  const host = new ChatHost({
    ...options,
    broadcast: (event, args) => broadcast("chat", event, args),
  });
  const { oauth } = host;

  register("chat", {
    call: {
      start: async (args: unknown) => {
        const {
          workspaceId,
          tabId,
          cwd,
          resume,
          fork,
          resumeAt,
          resetLog,
          connectionChanged,
          usageOnly,
          profileId,
          instructions,
        } = validateArgs(c.start.args, args);
        return ipcOk(
          await host.start(
            workspaceId,
            tabId,
            cwd,
            { resume, fork, resumeAt, resetLog, connectionChanged, usageOnly },
            profileId,
            instructions,
          ),
        );
      },
      codexStart: async (args: unknown) => {
        const { workspaceId, tabId, cwd, resetLog, connectionChanged, profileId } = validateArgs(
          c.codexStart.args,
          args,
        );
        return ipcOk(
          await host.startCodex(workspaceId, tabId, cwd, {
            resetLog,
            connectionChanged,
            profileId,
          }),
        );
      },
      send: async (args: unknown) => {
        const { workspaceId, tabId, message, ...layer } = validateArgs(c.send.args, args);
        try {
          await host.send(workspaceId, tabId, message, layer);
          return ipcOk(undefined);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          const detail = error instanceof Error ? error.message : String(error);
          return typeof code === "string"
            ? ipcErr(code, detail, { category: "failed" })
            : ipcErr("chat.send-failed", detail, { category: "bug" });
        }
      },
      stop: async (args: unknown) => {
        await host.call("stop", validateArgs(c.stop.args, args));
        return ipcOk(undefined);
      },
      close: async (args: unknown) => {
        await host.call("close", validateArgs(c.close.args, args));
        return ipcOk(undefined);
      },
      replay: async (args: unknown) => {
        const result = (await host.call("replay", validateArgs(c.replay.args, args))) as
          | { found: boolean; running?: boolean; truncated?: boolean; lastSeq?: number }
          | undefined;
        return ipcOk({
          found: result?.found === true,
          running: result?.running === true,
          truncated: result?.truncated === true,
          lastSeq: result?.lastSeq ?? 0,
        });
      },
      attach: async (args: unknown) => {
        const result = (await host.call("attach", validateArgs(c.attach.args, args))) as
          | { path?: string }
          | undefined;
        if (!result?.path) throw new Error("the agent wrote no file");
        return ipcOk({ path: result.path });
      },
      attachRoot: async (args: unknown) => {
        const { workspaceId } = validateArgs(c.attachRoot.args, args);
        return ipcOk({ root: options.workspaceManager.getAttachRoot?.(workspaceId) ?? null });
      },
      pruneAttachments: async (args: unknown) => {
        await host.call("pruneAttachments", validateArgs(c.pruneAttachments.args, args));
        return ipcOk(undefined);
      },
      transcript: withProfileError(async (args: unknown) => {
        const { workspaceId, sessionId, profileId } = validateArgs(c.transcript.args, args);
        const result = (await host.transcript(workspaceId, sessionId, profileId)) as {
          found?: boolean;
          lines?: unknown[];
          truncated?: boolean;
        };
        return ipcOk({
          found: result.found === true,
          lines: result.lines ?? [],
          truncated: result.truncated === true,
        });
      }),
      transcriptPage: withProfileError(async (args: unknown) => {
        const { workspaceId, sessionId, profileId, ...page } = validateArgs(
          c.transcriptPage.args,
          args,
        );
        try {
          return ipcOk(await host.transcriptPage(workspaceId, sessionId, profileId, page));
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === "chat.transcript-cursor-stale") {
            return ipcErr(code, "The chat history changed. Try reading earlier messages again.", {
              category: "failed",
            });
          }
          const failure = agentCallError(error);
          if (failure) return failure;
          throw error;
        }
      }),
      subagentTranscript: withProfileError(async (args: unknown) => {
        const { workspaceId, sessionId, agentId, toolUseId, profileId } = validateArgs(
          c.subagentTranscript.args,
          args,
        );
        const result = (await host.subagentTranscript(
          workspaceId,
          sessionId,
          { ...(agentId ? { agentId } : {}), ...(toolUseId ? { toolUseId } : {}) },
          profileId,
        )) as { found?: boolean; lines?: unknown[]; truncated?: boolean };
        return ipcOk({
          found: result.found === true,
          lines: result.lines ?? [],
          truncated: result.truncated === true,
        });
      }),
      sessionFile: withProfileError(async (args: unknown) => {
        const { workspaceId, sessionId, profileId } = validateArgs(c.sessionFile.args, args);
        const result = (await host.sessionFile(workspaceId, sessionId, profileId)) as {
          found?: boolean;
          path?: string;
        };
        return ipcOk(
          result.found === true && result.path
            ? { found: true, path: result.path }
            : { found: false },
        );
      }),
      stageThread: withProfileError(async (args: unknown) => {
        const { workspaceId, threadId, ...options } = validateArgs(c.stageThread.args, args);
        const result = (await host.stageThread(workspaceId, threadId, options)) as {
          found?: boolean;
        };
        return ipcOk({ found: result.found === true });
      }),
      claudeConfig: withProfileError(async (args: unknown) => {
        const { workspaceId, profileId } = validateArgs(c.claudeConfig.args, args);
        const result = (await host.claudeConfig(workspaceId, profileId)) as {
          found?: boolean;
          values?: unknown;
        };
        if (result.found !== true) return ipcOk({ found: false, values: {} });
        return ipcOk(
          validateArgs(c.claudeConfig.result, { found: true, values: result.values ?? {} }),
        );
      }),
      oauthListen: async () => {
        try {
          return ipcOk(await oauth.listen());
        } catch (error) {
          if (error instanceof OAuthCallbacksClosedError) {
            return ipcErr("chat.oauth-closed", error.message, { category: "cancelled" });
          }
          const message = error instanceof Error ? error.message : String(error);
          return ipcErr("chat.oauth-listen-failed", message, { category: "failed" });
        }
      },
      oauthWait: async (args: unknown) => {
        const { id } = validateArgs(c.oauthWait.args, args);
        return ipcOk({ url: await oauth.wait(id) });
      },
      oauthCancel: async (args: unknown) => {
        oauth.cancel(validateArgs(c.oauthCancel.args, args).id);
        return ipcOk(undefined);
      },
      cli: withProfileError(async (args: unknown) => {
        const { workspaceId, cwd, command, profileId } = validateArgs(c.cli.args, args);
        return ipcOk(await host.cli(workspaceId, cwd, command, profileId));
      }),
      sessions: withProfileError(async (args: unknown) => {
        const { workspaceId, cwd, profileId } = validateArgs(c.sessions.args, args);
        const result = (await host.sessions(workspaceId, cwd, profileId)) as {
          sessions?: unknown;
        };
        return ipcOk(validateArgs(c.sessions.result, result.sessions ?? []));
      }),
      deleteSession: withProfileError(async (args: unknown) => {
        const { workspaceId, cwd, sessionId, profileId } = validateArgs(c.deleteSession.args, args);
        const result = (await host.deleteSession(workspaceId, cwd, sessionId, profileId)) as {
          deleted?: unknown;
        };
        return ipcOk({ deleted: result.deleted === true });
      }),
      fileSizes: async (args: unknown) => {
        const { workspaceId, paths } = validateArgs(c.fileSizes.args, args);
        const result = (await host.fileSizes(workspaceId, paths)) as { sizes?: unknown };
        return ipcOk(validateArgs(c.fileSizes.result, result.sizes ?? {}));
      },
    },
    listen: {
      line: {},
      exit: {},
      held: {},
      resync: {},
    },
  });
  return host;
}
