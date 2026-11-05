// Claude tab IPC channel: renderer ↔ main ↔ the workspace's agent.

import { ipcContract } from "../../../shared/ipc/contract";
import { ipcOk } from "../../../shared/ipc/result";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { ChatHost, type ChatHostOptions } from "./host";
import { OAuthCallbacks } from "./oauth-callback";

const c = ipcContract.chat.call;

export function registerChatChannel(options: Omit<ChatHostOptions, "broadcast">): ChatHost {
  const host = new ChatHost({
    ...options,
    broadcast: (event, args) => broadcast("chat", event, args),
  });
  const oauth = new OAuthCallbacks();

  register("chat", {
    call: {
      start: async (args: unknown) => {
        const { workspaceId, tabId, cwd, resume, fork, resumeAt, resetLog } = validateArgs(
          c.start.args,
          args,
        );
        return ipcOk(
          await host.start(workspaceId, tabId, cwd, { resume, fork, resumeAt, resetLog }),
        );
      },
      send: async (args: unknown) => {
        const parsed = validateArgs(c.send.args, args);
        await host.call("send", parsed);
        return ipcOk(undefined);
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
      pruneAttachments: async (args: unknown) => {
        await host.call("pruneAttachments", validateArgs(c.pruneAttachments.args, args));
        return ipcOk(undefined);
      },
      transcript: async (args: unknown) => {
        const { workspaceId, sessionId } = validateArgs(c.transcript.args, args);
        const result = (await host.transcript(workspaceId, sessionId)) as {
          found?: boolean;
          lines?: unknown[];
          truncated?: boolean;
        };
        return ipcOk({
          found: result.found === true,
          lines: result.lines ?? [],
          truncated: result.truncated === true,
        });
      },
      oauthListen: async () => ipcOk(await oauth.listen()),
      oauthWait: async (args: unknown) => {
        const { id } = validateArgs(c.oauthWait.args, args);
        return ipcOk({ url: await oauth.wait(id) });
      },
      oauthCancel: async (args: unknown) => {
        oauth.cancel(validateArgs(c.oauthCancel.args, args).id);
        return ipcOk(undefined);
      },
      background: async (args: unknown) => {
        const { workspaceId, cwd, command } = validateArgs(c.background.args, args);
        return ipcOk(await host.background(workspaceId, cwd, command));
      },
      sessions: async (args: unknown) => {
        const { workspaceId, cwd } = validateArgs(c.sessions.args, args);
        const result = (await host.sessions(workspaceId, cwd)) as { sessions?: unknown };
        return ipcOk(validateArgs(c.sessions.result, result.sessions ?? []));
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
