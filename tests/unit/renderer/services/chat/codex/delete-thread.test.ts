/**
 * Deleting one of the folder's Codex threads removes the files its messages
 * attached, read before the thread goes. The answers here are shaped as
 * codex-cli 0.170.0's app-server protocol types them (`codex app-server
 * generate-ts`): ThreadReadResponse {thread: Thread}, Thread.turns: Turn[],
 * ThreadTurnsListResponse {data: Turn[], nextCursor, backwardsCursor}, and a
 * userMessage item's content: UserInput[].
 */
import { afterEach, expect, mock, test } from "bun:test";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

type Message = Record<string, unknown>;
const WS = "ws-codex-delete-thread";
const ROOT = "/home/me/.nexus-code/attach";
let codex: ((message: Message) => void) | undefined;
let onStart: (() => void) | undefined;
let root: string | null = ROOT;
let version = "0.170.0";
const sent: Message[] = [];
const removed: unknown[] = [];

const realIpc = await import("../../../../../../src/renderer/ipc/client");
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string, args: Record<string, unknown>) => {
    if (method === "send") codex?.(args.message as Message);
    if (method === "codexStart") {
      onStart?.();
      return Promise.resolve({ ok: true, value: { ok: true, pid: 1, attached: false, version } });
    }
    if (method === "replay") {
      return Promise.resolve({
        ok: true,
        value: { found: false, running: false, truncated: false, lastSeq: 0 },
      });
    }
    if (method === "attachRoot") return Promise.resolve({ ok: true, value: { root } });
    if (method === "removeAttachments") removed.push(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { CodexController } = await import(
  "../../../../../../src/renderer/services/chat/codex/controller"
);
const { codexThreadItems } = await import(
  "../../../../../../src/renderer/services/chat/codex/model"
);
const { appendCodexThreadPage, emptyCodexThreadPages } = await import(
  "../../../../../../src/renderer/services/chat/codex/history"
);
const { attachedFilesIn } = await import(
  "../../../../../../src/renderer/services/chat/attach-retention"
);
type Controller = InstanceType<typeof CodexController>;

let seq = 0;
let lineSeq = 9000;
const live: Controller[] = [];

afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
  codex = undefined;
  onStart = undefined;
  root = ROOT;
  version = "0.170.0";
  sent.length = 0;
  removed.length = 0;
});

const userMessage = (id: string, text: string) => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});
const agentMessage = (id: string, text: string) => ({
  type: "agentMessage",
  moderation: null,
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const turn = (id: string, items: unknown[]) => ({
  id,
  rootTurnId: id,
  items,
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: 1_763_000_000,
  completedAt: 1_763_000_010,
  durationMs: 10_000,
});
const FIRST = turn("turn-1", [
  userMessage(
    "item-1",
    `look at these\n\n@${ROOT}/${WS}/tab-a/1/shot.png @${ROOT}/${WS}/tab-a/2/notes.md`,
  ),
  agentMessage("item-2", "Seen."),
]);
const SECOND = turn("turn-2", [
  userMessage("item-3", `and this one\n\n@${ROOT}/${WS}/tab-b/1/log.txt`),
  agentMessage("item-4", "Read."),
]);
/** A Thread as thread/read answers it with includeTurns. */
const thread = (turns: unknown[]) => ({
  id: "gone",
  sessionId: "gone",
  forkedFromId: null,
  parentThreadId: null,
  preview: "look at these",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  model: "gpt-5.5",
  reasoningEffort: "medium",
  createdAt: 1_763_000_000,
  updatedAt: 1_763_000_010,
  recencyAt: null,
  status: { type: "notLoaded" },
  path: null,
  cwd: "/p",
  cliVersion: "0.170.0",
  originator: null,
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns,
});
const NAMED = [
  `${ROOT}/${WS}/tab-a/1/shot.png`,
  `${ROOT}/${WS}/tab-a/2/notes.md`,
  `${ROOT}/${WS}/tab-b/1/log.txt`,
];

test("a thread/read answer's turns show the files its messages attached", () => {
  const items = codexThreadItems({ thread: thread([FIRST, SECOND]) });
  expect(items.filter((item) => item.kind === "user").map((item) => item.text)).toEqual([
    `look at these\n\n@${ROOT}/${WS}/tab-a/1/shot.png @${ROOT}/${WS}/tab-a/2/notes.md`,
    `and this one\n\n@${ROOT}/${WS}/tab-b/1/log.txt`,
  ]);
  expect(attachedFilesIn(items, "/p")).toEqual(NAMED);
  expect(codexThreadItems({})).toEqual([]);
});

test("pages of turns join while each cursor leads on to one not seen", () => {
  const first = appendCodexThreadPage(emptyCodexThreadPages(), {
    data: [FIRST],
    nextCursor: "c1",
    backwardsCursor: "b1",
  });
  const second = first && appendCodexThreadPage(first, { data: [SECOND], nextCursor: null });
  expect(second).toEqual({ turns: [FIRST, SECOND], nextCursor: null, cursors: ["c1"] });
  // After the last page, nothing more.
  expect(second && appendCodexThreadPage(second, { data: [], nextCursor: null })).toBeUndefined();
  // A cursor seen before, an empty page that goes on, or no turns: the chain is broken.
  expect(
    first && appendCodexThreadPage(first, { data: [SECOND], nextCursor: "c1" }),
  ).toBeUndefined();
  expect(appendCodexThreadPage(emptyCodexThreadPages(), { data: [], nextCursor: "c1" })).toBe(
    undefined,
  );
  expect(appendCodexThreadPage(emptyCodexThreadPages(), { nextCursor: null })).toBeUndefined();
});

/** A tab whose app-server answers as `reply` says. */
function tab(reply: (message: Message) => unknown): Controller {
  const c = new CodexController({ workspaceId: WS, tabId: `d${++seq}`, cwd: "/p", threadId: "t1" });
  live.push(c);
  const line = (dir: "sys" | "in" | "out", message: Message) =>
    c.receive({ seq: ++lineSeq, dir, message } as never);
  onStart = () => line("sys", { event: "start" });
  codex = (message) => {
    sent.push(message);
    line("in", message);
    if (message.id === undefined) return;
    const result =
      message.method === "initialize"
        ? { userAgent: `nexus-code/${version} (test)` }
        : message.method === "thread/resume"
          ? { thread: { id: "t1" } }
          : (reply(message) ?? {});
    line("out", { id: message.id, result });
  };
  return c;
}

const asked = () =>
  sent
    .map((message) => message.method as string)
    .filter((method) => ["thread/read", "thread/turns/list", "thread/delete"].includes(method));

test("deleting a thread reads its turns a page at a time, then removes what they attached", async () => {
  const c = tab((message) => {
    if (message.method !== "thread/turns/list") return undefined;
    const params = message.params as Message;
    expect(params).toMatchObject({ threadId: "gone", sortDirection: "asc", itemsView: "full" });
    return params.cursor === "c1"
      ? { data: [SECOND], nextCursor: null, backwardsCursor: "b2" }
      : { data: [FIRST], nextCursor: "c1", backwardsCursor: "b1" };
  });
  await c.prepareSend();
  await c.deleteThread("gone");
  expect(asked()).toEqual(["thread/turns/list", "thread/turns/list", "thread/delete"]);
  expect(removed).toEqual([{ workspaceId: WS, slots: ["tab-a/1", "tab-a/2", "tab-b/1"] }]);
});

test("a Codex before paged history is read whole", async () => {
  version = "0.169.0";
  const c = tab((message) =>
    message.method === "thread/read" ? { thread: thread([FIRST]) } : undefined,
  );
  await c.prepareSend();
  await c.deleteThread("gone");
  expect(asked()).toEqual(["thread/read", "thread/delete"]);
  expect(sent.find((message) => message.method === "thread/read")?.params).toEqual({
    threadId: "gone",
    includeTurns: true,
  });
  expect(removed).toEqual([{ workspaceId: WS, slots: ["tab-a/1", "tab-a/2"] }]);
});

test("a thread whose pages break is deleted, its files left to the prune", async () => {
  const c = tab((message) =>
    message.method === "thread/turns/list"
      ? { data: [FIRST], nextCursor: "again", backwardsCursor: null }
      : undefined,
  );
  await c.prepareSend();
  await c.deleteThread("gone");
  expect(asked()).toEqual(["thread/turns/list", "thread/turns/list", "thread/delete"]);
  expect(removed).toEqual([]);
});
