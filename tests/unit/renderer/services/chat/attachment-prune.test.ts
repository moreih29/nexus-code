import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const ROOT = "/Users/me/.nexus-code/attach";
let root: string | null = ROOT;
/** The slots each conversation's whole history names, as its agent reads them; absent: it cannot. */
let histories: Record<string, string[]> = {};
/** Calls answered with a failure, by their order among the calls to `failing`. */
let failing: { method: string; at: number[] } | undefined;
const calls: { method: string; args: unknown }[] = [];
const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    if (channel !== "chat") return Promise.resolve({ ok: true, value: undefined });
    if (method === "attachRoot") return Promise.resolve({ ok: true, value: { root } });
    calls.push({ method, args });
    if (method === "historySlots") {
      const slots = histories[(args as { conversation: string }).conversation];
      return Promise.resolve(
        slots
          ? { ok: true, value: { slots } }
          : { ok: false, error: { code: "request-failed", message: "unread" } },
      );
    }
    if (failing?.method === method && failing.at.includes(of(method).length - 1)) {
      return Promise.resolve({ ok: false, error: { code: "request-failed", message: "no" } });
    }
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
  failing = undefined;
  histories = { s1: [], s2: [], s3: [], t: [] };
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

test("no prune by use before the agent tells its attach root: an open conversation's files would look unused", async () => {
  root = null;
  const tab = useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: "/p" } });
  expect(await retention.pruneAttachments(WS)).toBe(false);
  // Main prunes only where the agent names no root, whose tabs' files went as they closed.
  expect(of("pruneAttachments")).toEqual([{ workspaceId: WS, keepTabIds: [tab.id] }]);
  // No room is made there: nothing is kept past its tab.
  expect(await retention.pruneAttachments(WS, true)).toBe(false);
  expect(of("pruneAttachments")).toHaveLength(1);
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

test("a closing tab marks used what its conversation names, though marked before", async () => {
  const tabs = useTabsStore.getState();
  const tab = tabs.createTab(WS, {
    type: "claude",
    props: { cwd: "/p", attachments: { conversation: "t", slots: ["t0/1", "older/3"] } },
  });
  const other = tabs.createTab(WS, { type: "codex", props: { cwd: "/p" } });
  retention.pruneAttachmentsOnce(WS);
  shows(tab.id, "t", `${ROOT}/${WS}/t0/1/a.png`, `${ROOT}/${WS}/t0/2/b.png`);
  await retention.followAttachmentsNow();
  expect(of("touchAttachments")).toEqual([{ workspaceId: WS, slots: ["t0/1", "t0/2"] }]);
  useTabsStore.getState().removeTab(WS, tab.id);
  await Bun.sleep(0);
  expect(of("touchAttachments").at(-1)).toEqual({
    workspaceId: WS,
    slots: ["t0/1", "older/3", "t0/2"],
  });
  // A tab that names nothing marks nothing.
  const touches = of("touchAttachments").length;
  useTabsStore.getState().removeTab(WS, other.id);
  await Bun.sleep(0);
  expect(of("touchAttachments")).toHaveLength(touches);
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

test("a call of slots that fails stops none after it", async () => {
  const slots = Array.from({ length: 12_000 }, (_, i) => `old/${i + 1}`);
  const items = [sent("a", slots.map((slot) => `@${ROOT}/${WS}/${slot}/f.png`).join(" "))];
  failing = { method: "removeAttachments", at: [0] };
  await expect(retention.removeConversationAttachments(WS, items as never, "/p")).rejects.toThrow();
  expect(
    (of("removeAttachments") as Array<{ slots: string[] }>).map((call) => call.slots.length),
  ).toEqual([5000, 5000, 2000]);
});

test("a fork open in a tab keeps what its history names early on, past the pages it loaded", async () => {
  // C, long, named early/1 early on; tab B is a fork of it, which loaded only its last page.
  histories = { "b-fork": ["early/1", "late/2"] };
  const fork = useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: "/p" } });
  shows(fork.id, "b-fork", `${ROOT}/${WS}/old-tab/2/late.png`);
  const items = [
    sent("a", `first\n\n@${ROOT}/${WS}/early/1/a.png`),
    sent("b", `after the fork\n\n@${ROOT}/${WS}/after/9/b.png`),
  ];
  // Deleting C: the open tabs' histories are read while it is there.
  expect(await retention.readOpenHistories(WS)).toBe(true);
  expect(of("historySlots")).toEqual([
    { workspaceId: WS, agent: "claude", conversation: "b-fork" },
  ]);
  await retention.removeConversationAttachments(WS, items as never, "/p");
  expect(of("removeAttachments")).toEqual([{ workspaceId: WS, slots: ["after/9"] }]);
});

test("a fork not yet its own keeps what the conversation it copies names, in that one's profile", async () => {
  histories = { "c-long": ["early/1"] };
  useTabsStore.getState().createTab(WS, {
    type: "codex",
    props: { cwd: "/p", profileId: "mine", fork: { threadId: "c-long", profileId: "theirs" } },
  });
  expect(await retention.readOpenHistories(WS)).toBe(true);
  expect(of("historySlots")).toEqual([
    { workspaceId: WS, agent: "codex", conversation: "c-long", profileId: "theirs" },
  ]);
  const items = [sent("a", `@${ROOT}/${WS}/early/1/a.png @${ROOT}/${WS}/solo/3/c.png`)];
  await retention.removeConversationAttachments(WS, items as never, "/p");
  expect(of("removeAttachments")).toEqual([{ workspaceId: WS, slots: ["solo/3"] }]);
});

test("nothing goes while an open tab's history cannot be read", async () => {
  histories = {};
  const tab = useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: "/p" } });
  shows(tab.id, "unread");
  expect(await retention.readOpenHistories(WS)).toBe(false);
  await retention.removeConversationAttachments(
    WS,
    [sent("a", `@${ROOT}/${WS}/solo/3/c.png`)] as never,
    "/p",
  );
  expect(of("removeAttachments")).toEqual([]);
  await expect(retention.pruneAttachments(WS)).rejects.toThrow();
  expect(of("pruneAttachments")).toEqual([]);
});

test("a history that cannot be read is asked for again only a while on", async () => {
  histories = {};
  const tab = useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: "/p" } });
  retention.pruneAttachmentsOnce(WS);
  await Bun.sleep(0);
  const now = spyOn(Date, "now");
  try {
    const start = Date.now();
    // Each look at the streaming chat, and each prune, asks nothing more.
    for (let i = 1; i <= 3; i++) {
      shows(tab.id, "unread", `${ROOT}/${WS}/t0/${i}/a.png`);
      await retention.followAttachmentsNow();
      await expect(retention.pruneAttachments(WS)).rejects.toThrow();
    }
    expect(of("historySlots")).toHaveLength(1);
    // What the tab loaded is still kept and marked used.
    expect(of("touchAttachments")).toHaveLength(3);
    // Once it can be read, a while on, the prune goes.
    histories = { unread: ["early/1"] };
    now.mockReturnValue(start + retention.HISTORY_RETRY_MS + 1_000);
    expect(await retention.pruneAttachments(WS)).toBe(true);
    expect(of("historySlots")).toHaveLength(2);
    expect(of("pruneAttachments").at(-1)).toMatchObject({
      keepSlots: expect.arrayContaining(["early/1", "t0/3"]),
    });
  } finally {
    now.mockRestore();
  }
});

test("a conversation gone on after days keeps and marks used what it named early on", async () => {
  // Twenty days idle; its tab loads the last page, which names new/2 alone.
  histories = { "s-20": ["old/1", "new/2"] };
  const tab = useTabsStore.getState().createTab(WS, { type: "claude", props: { cwd: "/p" } });
  retention.pruneAttachmentsOnce(WS);
  shows(tab.id, "s-20", `${ROOT}/${WS}/new/2/b.png`);
  await retention.followAttachmentsNow();
  const now = useTabsStore.getState().byWorkspace[WS]?.[tab.id];
  expect(now?.type === "claude" ? now.props.attachments : undefined).toEqual({
    conversation: "s-20",
    slots: ["old/1", "new/2"],
  });
  expect(of("touchAttachments")).toEqual([{ workspaceId: WS, slots: ["old/1", "new/2"] }]);
  // Ten days on, with the tab still open, a prune keeps it.
  await retention.pruneAttachments(WS);
  expect(of("pruneAttachments").at(-1)).toEqual({
    workspaceId: WS,
    keepTabIds: [tab.id],
    keepSlots: ["old/1", "new/2"],
  });
  // The history was asked once.
  expect(of("historySlots")).toHaveLength(1);
});
