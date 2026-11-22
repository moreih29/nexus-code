import type { RemoteSession, SessionState } from "../../../../packages/remote-protocol/src/rpc";
import type { TerminalOpener } from "../../../shared/chat/relay";
import type { AgentSession } from "../agent-sessions/model";
import type { RowGroup } from "../agent-sessions/rows";
import { searchSessionTree, sessionTree } from "../agent-sessions/session-tree";
import { remoteDisplayName } from "../remote/display-name";
import { remoteSessionKey } from "./layout";

export const GROUP_OF: Record<SessionState, RowGroup> = {
  "needs-you": "attention",
  running: "running",
  "new-result": "done",
  idle: "idle",
  ended: "idle",
};

export function remoteGroupOf(session: RemoteSession): RowGroup {
  return session.failed && session.state !== "ended" ? "attention" : GROUP_OF[session.state];
}

export function remoteSessionTree(
  deviceId: string,
  sessions: readonly RemoteSession[],
  query: string,
) {
  const byKey = new Map(
    sessions.map((session) => [remoteSessionKey({ deviceId, ...session }), session]),
  );
  const keysByTab = new Map<string, string | undefined>();
  for (const [key, session] of byKey) {
    keysByTab.set(session.tabId, keysByTab.has(session.tabId) ? undefined : key);
  }

  function openerOf(opener: RemoteSession["openedBy"]): TerminalOpener | undefined {
    if (!opener) return undefined;
    const { kind = "tab", agent, device } = opener;
    const name =
      remoteDisplayName(opener.name ?? "") || remoteDisplayName(opener.tabId.slice(0, 8));
    if (device)
      return { ...opener, kind, name, device: { ...device, name: remoteDisplayName(device.name) } };
    const tabId = keysByTab.get(opener.tabId);
    return { kind, agent, name, tabId };
  }

  const rows: AgentSession[] = Array.from(byKey, ([key, session]) => ({
    key,
    workspaceId: session.workspaceId,
    tabId: key,
    title: remoteDisplayName(session.title),
    parent: openerOf(session.openedBy),
    kind: session.kind,
    agent: session.kind === "terminal" ? session.agent : session.kind,
    state: session.state === "ended" ? "exited" : session.state,
    phase: remoteGroupOf(session),
    estimated: false,
    since: session.since,
    message: session.last,
    prompt: undefined,
  }));
  // A tab ID must identify a single session on the host. Ambiguous openers
  // keep their label and cannot attach sessions to unrelated workspaces.
  return { byKey, roots: searchSessionTree(sessionTree(rows), query) };
}
