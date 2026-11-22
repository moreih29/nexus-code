/**
 * A fake renderer's sessions.snapshot, made of its answers to the requests
 * the sessions' list made one by one before: tabs.list with agentOrder,
 * chat.state with peek and includeWaitingId, sessions.results. The app's
 * renderer answers it the same way (services/cli/ui-requests.ts).
 */
import type { CliSessionChat, CliSessionTab } from "../../src/shared/cli/ui";
import { oneLine } from "../../src/shared/remote/one-line";

/** A fake's answers: any request, any result. */
type Ui = (op: any, args: any, timeoutMs?: number) => Promise<any>;

function sessionChat(info: Record<string, unknown>): CliSessionChat {
  const waiting = info.waiting as CliSessionChat["waiting"];
  return {
    state: info.state as CliSessionChat["state"],
    ...(info.since !== undefined ? { since: info.since as number } : {}),
    ...(info.message ? { message: oneLine(info.message as string) } : {}),
    ...(info.profile ? { profile: info.profile as string } : {}),
    ...(info.cwd ? { cwd: info.cwd as string } : {}),
    ...(waiting ? { waiting: { kind: waiting.kind, text: oneLine(waiting.text) } } : {}),
    ...(info.limitResume ? { limitResume: info.limitResume } : {}),
    ...(info.waitingId ? { waitingId: info.waitingId as string } : {}),
  } as CliSessionChat;
}

export function withSessionsSnapshot<T extends Ui>(ui: T): T {
  return (async (op: string, args: Record<string, unknown>, timeoutMs?: number) => {
    if (op !== "sessions.snapshot") return ui(op, args, timeoutMs);
    const read = async (workspaceId: string) => {
      const listed = await ui("tabs.list", { workspaceId, agentOrder: true }).catch(
        () => undefined,
      );
      if (!listed) return {};
      const tabs = await Promise.all(
        (listed.tabs as CliSessionTab[]).map(async (tab): Promise<CliSessionTab> => {
          const row: CliSessionTab = {
            id: tab.id,
            type: tab.type,
            title: tab.title,
            ...(tab.dead ? { dead: true } : {}),
            ...(tab.unstarted ? { unstarted: true } : {}),
          };
          if (tab.type !== "claude" && tab.type !== "codex") return row;
          const info = await ui("chat.state", {
            workspaceId,
            tabId: tab.id,
            peek: true,
            includeWaitingId: true,
          }).catch(() => undefined);
          return info ? { ...row, chat: sessionChat(info) } : row;
        }),
      );
      return { tabs };
    };
    const workspaces = await Promise.all((args.workspaceIds as string[]).map(read));
    const results = await ui("sessions.results", {}).catch(() => undefined);
    return { workspaces, ...(results?.unread ? { unread: results.unread } : {}) };
  }) as T;
}
