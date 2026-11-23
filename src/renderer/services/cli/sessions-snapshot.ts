import type {
  CliChatInfo,
  CliSessionChat,
  CliSessionsSnapshotCursor,
  CliSessionTab,
  CliUiOps,
} from "../../../shared/cli/ui";
import { oneLine } from "../../../shared/remote/one-line";

type ChatInfo = CliChatInfo & { waitingId?: string };
type Snapshot = CliUiOps["sessions.snapshot"];

export interface SessionsSnapshotReaders {
  readRevision(): number;
  listTabs(workspaceId: string): readonly Omit<CliSessionTab, "chat">[];
  peekChat(workspaceId: string, tabId: string): ChatInfo;
  readUnread(): NonNullable<Snapshot["result"]["unread"]>;
}

function sessionChat(info: ChatInfo): CliSessionChat {
  return {
    state: info.state,
    ...(info.since !== undefined ? { since: info.since } : {}),
    ...(info.message ? { message: oneLine(info.message) } : {}),
    ...(info.profile ? { profile: info.profile } : {}),
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(info.waiting
      ? { waiting: { kind: info.waiting.kind, text: oneLine(info.waiting.text) } }
      : {}),
    ...(info.limitResume ? { limitResume: info.limitResume } : {}),
    ...(info.waitingId ? { waitingId: info.waitingId } : {}),
  };
}

export function snapshotTab(tab: Omit<CliSessionTab, "chat">, chat?: ChatInfo): CliSessionTab {
  return {
    id: tab.id,
    type: tab.type,
    title: tab.title,
    ...(tab.dead ? { dead: true } : {}),
    ...(tab.unstarted ? { unstarted: true } : {}),
    ...(tab.openedBy ? { openedBy: tab.openedBy } : {}),
    ...(chat ? { chat: sessionChat(chat) } : {}),
  };
}

export const MAX_SESSION_SNAPSHOT_TABS = 1_000;

export function sessionsSnapshot(
  { workspaceIds, cursor }: Snapshot["args"],
  readers: SessionsSnapshotReaders,
): Snapshot["result"] {
  const revision = readers.readRevision();
  const workspaces: Snapshot["result"]["workspaces"] = [];
  let left = MAX_SESSION_SNAPSHOT_TABS;
  let next: CliSessionsSnapshotCursor | undefined;
  for (let workspace = cursor?.workspace ?? 0; workspace < workspaceIds.length; workspace++) {
    const tab = workspace === cursor?.workspace ? cursor.tab : 0;
    if (left === 0) {
      next = { workspace, tab };
      break;
    }
    const workspaceId = workspaceIds[workspace];
    try {
      const listed = readers.listTabs(workspaceId);
      const tabs = listed.slice(tab, tab + left).map((tab) => {
        if (tab.type === "claude" || tab.type === "codex") {
          try {
            return snapshotTab(tab, readers.peekChat(workspaceId, tab.id));
          } catch {}
        }
        return snapshotTab(tab);
      });
      workspaces.push({ tabs });
      left -= tabs.length;
      if (tab + tabs.length < listed.length) {
        next = { workspace, tab: tab + tabs.length };
        break;
      }
    } catch {
      workspaces.push({});
    }
  }
  let unread: Snapshot["result"]["unread"];
  try {
    if (!cursor) unread = readers.readUnread();
  } catch {}
  return { revision, workspaces, ...(unread ? { unread } : {}), ...(next ? { next } : {}) };
}
