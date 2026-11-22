/**
 * A fake renderer's sessions.snapshot, made of its answers to the requests
 * the sessions' list made one by one before: tabs.list with agentOrder,
 * chat.state with peek and includeWaitingId, sessions.results. The app's
 * renderer answers it the same way (services/cli/ui-requests.ts).
 */
import type { SessionsRenderer, SessionsRevision } from "../../src/main/features/cli/context";
import { snapshotTab } from "../../src/renderer/services/cli/sessions-snapshot";
import type { CliSessionTab } from "../../src/shared/cli/ui";

type Ui = (op: any, args: any, timeoutMs?: number) => Promise<any>;

export function testSessionsRevision(snapshot: SessionsRenderer["snapshot"]): SessionsRevision & {
  saw(revision: number): void;
} {
  let latest: number | undefined;
  const renderer: SessionsRenderer = {
    get latest() {
      return latest;
    },
    closed: false,
    saw(revision) {
      if (latest === undefined || revision > latest) latest = revision;
    },
    snapshot,
  };
  return { current: () => renderer, saw: renderer.saw };
}

/** `revision`: the renderer's count of changes, which a snapshot tells. */
export function withSessionsSnapshot<T extends Ui>(ui: T, revision: () => number = () => 0): T {
  return (async (op: string, args: Record<string, unknown>, timeoutMs?: number) => {
    if (op !== "sessions.snapshot") return ui(op, args, timeoutMs);
    const at = revision();
    const read = async (workspaceId: string) => {
      const listed = await ui("tabs.list", { workspaceId, agentOrder: true }).catch(
        () => undefined,
      );
      if (!listed) return {};
      const tabs = await Promise.all(
        (listed.tabs as CliSessionTab[]).map(async (tab): Promise<CliSessionTab> => {
          if (tab.type !== "claude" && tab.type !== "codex") return snapshotTab(tab);
          const info = await ui("chat.state", {
            workspaceId,
            tabId: tab.id,
            peek: true,
            includeWaitingId: true,
          }).catch(() => undefined);
          return snapshotTab(tab, info);
        }),
      );
      return { tabs };
    };
    const workspaces = await Promise.all((args.workspaceIds as string[]).map(read));
    const results = await ui("sessions.results", {}).catch(() => undefined);
    return {
      revision: at,
      workspaces,
      ...(results?.unread ? { unread: results.unread } : {}),
    };
  }) as T;
}
