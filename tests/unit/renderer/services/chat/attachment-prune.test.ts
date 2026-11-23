import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const ROOT = "/Users/me/.nexus-code/attach";
let root: string | null = ROOT;
const calls: { method: string; args: unknown }[] = [];
const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    if (channel !== "chat") return Promise.resolve({ ok: true, value: undefined });
    if (method === "attachRoot") return Promise.resolve({ ok: true, value: { root } });
    calls.push({ method, args });
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const retention = await import("../../../../../src/renderer/services/chat/attach-retention");
const { chatKey, emptyTabState, useChatStore } = await import(
  "../../../../../src/renderer/services/chat/store"
);

const WS = "ws-attachment-prune";
const saved = useTabsStore.getState().byWorkspace;

function sent(key: string, text: string) {
  return { kind: "user" as const, key, text, images: [], state: "taken" as const };
}

/** The chat a tab shows: its session, and messages naming these files. */
function shows(tabId: string, sessionId: string, ...files: string[]) {
  const state = emptyTabState();
  useChatStore.getState().update(chatKey(WS, tabId), () => ({
    ...state,
    model: {
      ...state.model,
      sessionId,
      items: files.map((file, i) => sent(`${tabId}-${i}`, `look\n\n@${file}`)),
    },
  }));
}

function of(method: string) {
  return calls.filter((call) => call.method === method).map((call) => call.args);
}

beforeEach(() => {
  root = ROOT;
  calls.length = 0;
  retention.resetAttachmentRetention();
  useChatStore.setState({ tabs: {} });
});

afterEach(() => {
  retention.resetAttachmentRetention();
  useTabsStore.setState({ byWorkspace: saved });
});

test("a prune keeps the open Claude and Codex tabs and what their conversations name", async () => {
  const tabs = useTabsStore.getState();
  const codex = tabs.createTab(WS, { type: "codex", props: { cwd: "/p" } });
  const claude = tabs.createTab(WS, {
    type: "claude",
    props: { cwd: "/p", attachments: { conversation: "s-old", slots: ["gone-tab/4"] } },
  });
  tabs.createTab("ws-other-attachments", { type: "codex", props: { cwd: "/other" } });
  shows(claude.id, "s1", `${ROOT}/${WS}/closed-tab/2/a.png`, "/Users/me/Desktop/b.png");
  retention.pruneAttachmentsOnce(WS);
  retention.pruneAttachmentsOnce(WS);
  await Bun.sleep(0);
  expect(of("pruneAttachments")).toEqual([
    {
      workspaceId: WS,
      keepTabIds: [codex.id, claude.id],
      keepSlots: ["gone-tab/4", "closed-tab/2"],
    },
  ]);
});

test("no prune before the agent tells its attach root: an open conversation's files would look unused", async () => {
  root = null;
  useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: "/p" } });
  expect(await retention.pruneAttachments(WS)).toBe(false);
  expect(of("pruneAttachments")).toEqual([]);
});

test("after a file is attached, only the room is made", async () => {
  useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: "/p" } });
  retention.pruneAttachmentsAfterAttach(WS);
  await Bun.sleep(0);
  expect(of("pruneAttachments")).toEqual([
    { workspaceId: WS, keepTabIds: expect.any(Array), keepSlots: [], capOnly: true },
  ]);
});

test("a tab keeps what its conversation names and marks it used once", async () => {
  const tab = useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: "/p" } });
  retention.pruneAttachmentsOnce(WS);
  shows(tab.id, "s1", `${ROOT}/${WS}/t0/1/a.png`, `${ROOT}/${WS}/t0/2/b.txt`, "/tmp/c.png");
  await retention.followAttachmentsNow();
  const props = () => {
    const now = useTabsStore.getState().byWorkspace[WS]?.[tab.id];
    return now?.type === "claude" ? now.props.attachments : undefined;
  };
  expect(props()).toEqual({ conversation: "s1", slots: ["t0/1", "t0/2"] });
  expect(of("touchAttachments")).toEqual([{ workspaceId: WS, slots: ["t0/1", "t0/2"] }]);
  // A message sent with another: that one is kept too, and marked used alone.
  shows(
    tab.id,
    "s1",
    `${ROOT}/${WS}/t0/1/a.png`,
    `${ROOT}/${WS}/t0/2/b.txt`,
    `${ROOT}/${WS}/t1/1/c.md`,
  );
  await retention.followAttachmentsNow();
  expect(props()?.slots).toEqual(["t0/1", "t0/2", "t1/1"]);
  expect(of("touchAttachments").at(-1)).toEqual({ workspaceId: WS, slots: ["t1/1"] });
  // Another conversation in the tab: what it names takes the place of the last one's.
  shows(tab.id, "s2", `${ROOT}/${WS}/t2/1/d.png`);
  await retention.followAttachmentsNow();
  expect(props()).toEqual({ conversation: "s2", slots: ["t2/1"] });
  // One that names nothing, or is not read yet, leaves what the tab keeps.
  shows(tab.id, "s3");
  await retention.followAttachmentsNow();
  expect(props()).toEqual({ conversation: "s2", slots: ["t2/1"] });
});

test("a deleted conversation's files go, but those an open tab uses", async () => {
  const tabs = useTabsStore.getState();
  const open = tabs.createTab(WS, {
    type: "codex",
    props: { cwd: "/p", attachments: { conversation: "t", slots: ["old/3"] } },
  });
  const items = [
    sent("a", `one\n\n@${ROOT}/${WS}/old/1/a.png @${ROOT}/${WS}/old/3/c.png`),
    sent("b", `two\n\n@${ROOT}/${WS}/${open.id}/1/mine.png`),
    sent("c", `three\n\n@${ROOT}/other-ws/old/2/x.png @/Users/me/Desktop/kept.png`),
  ];
  await retention.removeConversationAttachments(WS, items as never, "/p");
  expect(of("removeAttachments")).toEqual([{ workspaceId: WS, slots: ["old/1"] }]);
});
