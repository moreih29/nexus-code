import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  RemoteSession,
  RemoteWorkspace,
} from "../../../../../packages/remote-protocol/src/rpc";
import {
  PeerSessionsPanel,
  peerFamilyListing,
  peerFamilyRoot,
} from "../../../../../src/renderer/components/peer-workspace/sessions-panel";
import {
  PeerTaskInfo,
  peerChangeCode,
} from "../../../../../src/renderer/components/peer-workspace/task-info";
import type { PeerSessions } from "../../../../../src/renderer/services/remote/room";
import * as workspaceStore from "../../../../../src/renderer/state/stores/peer-workspace";
import type { RoomPeer } from "../../../../../src/shared/remote/room";

const { peerTargetId, usePeerWorkspaceStore } = workspaceStore;
type PeerWorkspaceTarget = workspaceStore.PeerWorkspaceTarget;

const peer: RoomPeer = { id: "desktop", name: "Desktop", online: true, platform: "linux" };
const root: RemoteWorkspace = { id: "repo", name: "Repo", path: "/repo" };
const task: RemoteWorkspace = {
  id: "task",
  name: "Task",
  path: "/repo-task",
  parentId: "repo",
  git: { branch: "fix-login", ahead: 0, behind: 0, uncommitted: 3 },
};
const empty: RemoteWorkspace = {
  id: "quiet",
  name: "Quiet",
  path: "/repo-quiet",
  parentId: "repo",
  git: { branch: "quiet-branch", ahead: 0, behind: 0, uncommitted: 0 },
};
const other: RemoteWorkspace = { id: "other", name: "Other", path: "/other" };
const sessions: RemoteSession[] = [
  {
    kind: "claude",
    tabId: "asks",
    workspaceId: "repo",
    title: "Asks first",
    state: "needs-you",
    waiting: { kind: "permission", requestId: "ask", text: "Run tools?", always: false },
  },
  { kind: "codex", tabId: "works", workspaceId: "task", title: "Works on task", state: "running" },
  { kind: "terminal", tabId: "plain", workspaceId: "repo", title: "plain shell", state: "idle" },
  { kind: "claude", tabId: "elsewhere", workspaceId: "other", title: "Not ours", state: "idle" },
];
const listing: PeerSessions = {
  status: "ready",
  list: { workspaces: [root, task, empty, other], sessions },
};
const target: PeerWorkspaceTarget = {
  accountKey: "account",
  deviceId: peer.id,
  deviceName: peer.name,
  platform: peer.platform,
  workspaceId: "repo",
  workspace: { id: "repo", name: "Repo", path: "/repo" },
};
const previous = usePeerWorkspaceStore.getState();

// Render the store's current state, not its first, as the running app does.
function currentStore() {
  const storeView = spyOn(workspaceStore, "usePeerWorkspaceStore");
  storeView.mockImplementation(
    Object.assign(
      <T,>(select: (state: typeof previous) => T) => select(usePeerWorkspaceStore.getState()),
      usePeerWorkspaceStore,
    ),
  );
  return storeView;
}

afterEach(() => usePeerWorkspaceStore.setState(previous, true));

test("the list is the workspace's family: the workspace and its tasks, from either", () => {
  const fromRoot = peerFamilyListing(target, listing, undefined);
  expect(fromRoot?.workspaces.map(({ id }) => id)).toEqual(["repo", "task", "quiet"]);
  expect(fromRoot?.sessions.map(({ tabId }) => tabId)).toEqual(["asks", "works", "plain"]);
  const fromTask = peerFamilyListing(
    { ...target, workspaceId: "task", workspace: { ...task } },
    listing,
    undefined,
  );
  expect(fromTask?.workspaces.map(({ id }) => id)).toEqual(["repo", "task", "quiet"]);
  // Until that computer lists the workspace, the sessions of the one shown.
  const shown = [sessions[0]] as RemoteSession[];
  expect(peerFamilyListing(target, { status: "loading" }, shown)?.sessions).toBe(shown);
  expect(peerFamilyListing(target, undefined, undefined)).toBeUndefined();
});

test("by state, the local list's group headings over the family's conversations", () => {
  usePeerWorkspaceStore.getState().select(target, null);
  const html = renderToStaticMarkup(
    <PeerSessionsPanel target={target} peer={peer} listing={listing} />,
  );
  expect(html).toContain('data-testid="peer-agent-list-status-view"');
  // Every group keeps its place: those with none are one dim line.
  for (const group of ["Needs you", "Working", "New result", "Idle"]) expect(html).toContain(group);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("opacity-60");
  expect(html.indexOf("Asks first")).toBeLessThan(html.indexOf("Works on task"));
  expect(html).toContain("Asks first");
  // A task's conversation, with its branch.
  expect(html).toContain("Works on task");
  expect(html).toContain("fix-login");
  // A shell with nothing to tell, and another workspace's conversation, are not in it.
  expect(html).not.toContain("plain shell");
  expect(html).not.toContain("Not ours");
  // The header: a search, the view switch, and no new conversation without control.
  expect(html).toContain('type="search"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).not.toContain("peer-agent-list-new-chat");
});

test("by task, the workspace and each task headed by its name and changes", () => {
  usePeerWorkspaceStore.getState().select(target, null);
  usePeerWorkspaceStore.getState().setAgentListView(peerTargetId(target), "task");
  const storeView = currentStore();
  let html: string;
  try {
    html = renderToStaticMarkup(
      <PeerSessionsPanel target={target} peer={peer} listing={listing} />,
    );
  } finally {
    storeView.mockRestore();
  }
  expect(html).toContain('data-testid="peer-agent-list-task-view"');
  expect(html.match(/peer-agent-list-task-header/g)).toHaveLength(3);
  expect(html.indexOf('aria-label="Repo"')).toBeLessThan(html.indexOf('aria-label="fix-login"'));
  expect(html).toContain('title="Uncommitted changes (3)"');
  // A task with none says so.
  expect(html).toContain("No conversations");
  expect(html).not.toContain("Not ours");
});

test("by task, conversations are the local list's one-line rows under headers that fold", () => {
  usePeerWorkspaceStore.getState().select(target, null);
  usePeerWorkspaceStore.getState().setAgentListView(peerTargetId(target), "task");
  const render = (serves: string[]) => {
    const storeView = currentStore();
    try {
      return renderToStaticMarkup(
        <PeerSessionsPanel target={target} peer={{ ...peer, serves }} listing={listing} />,
      );
    } finally {
      storeView.mockRestore();
    }
  };
  const html = render(["sessions", "chat.read"]);
  // An idle terminal is not listed by default.
  expect(html.match(/data-testid="remote-session-task-row"/g)).toHaveLength(2);
  expect(html).not.toContain('data-testid="remote-session-item"');
  // Folded until opened, as locally: no facts drawn.
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('aria-expanded="true"');
  expect(html).not.toContain("peer-agent-list-task-info");
  // Without control only what reads: its changes and its path.
  expect(html).toContain("Show changes");
  expect(html).not.toContain("Open a terminal in this task");
  expect(html).not.toContain('aria-label="New Claude conversation"');

  const controlled = render(["sessions", "chat.control", "terminal.control"]);
  expect(controlled.match(/aria-label="Open a terminal in this task"/g)).toHaveLength(3);
});

test("a worktree's facts are its folder, after its branch for the workspace itself", () => {
  const info = (workspace: RemoteWorkspace) =>
    renderToStaticMarkup(
      <PeerTaskInfo
        deviceId={peer.id}
        workspace={workspace}
        canRead={false}
        onOpenFile={() => {}}
        onShowChanges={() => {}}
      />,
    );
  expect(info(task)).toContain(">/repo-task<");
  expect(info({ ...root, git: { branch: "main", ahead: 0, behind: 0, uncommitted: 0 } })).toContain(
    "main · /repo",
  );
  // Unknown until git.status is read: neither files nor "no changes".
  expect(info(task)).not.toContain("No uncommitted changes");
  expect(peerChangeCode({ path: "a", staged: "A", unstaged: "M" })).toBe("A");
  expect(peerChangeCode({ path: "a", unstaged: "?" })).toBe("?");
});

test("a new conversation starts in the workspace its tasks are of, whichever is shown", () => {
  const family = peerFamilyListing(
    { ...target, workspaceId: "task", workspace: task },
    listing,
    [],
  );
  expect(peerFamilyRoot({ ...target, workspaceId: "task", workspace: task }, family)).toBe(root);
  expect(peerFamilyRoot(target, family)).toBe(root);
  // Before that computer lists its workspaces: the one shown.
  expect(peerFamilyRoot({ ...target, workspaceId: "task", workspace: task }, undefined)).toBe(task);
});

test("a new conversation there only where that computer lets this one control its chats", () => {
  usePeerWorkspaceStore.getState().select(target, null);
  const html = renderToStaticMarkup(
    <PeerSessionsPanel
      target={target}
      peer={{ ...peer, serves: ["sessions", "chat.read", "chat.control"] }}
      listing={listing}
    />,
  );
  expect(html).toContain("peer-agent-list-new-chat");
});

test("before that computer lists anything, the list waits or says it is offline", () => {
  expect(renderToStaticMarkup(<PeerSessionsPanel target={target} peer={peer} />)).toContain(
    "Loading",
  );
  expect(renderToStaticMarkup(<PeerSessionsPanel target={target} />)).toContain(
    "Desktop is offline",
  );
});
