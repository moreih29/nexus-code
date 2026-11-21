import { afterEach, expect, mock, test } from "bun:test";
import type { ChatLine } from "../../../../../../src/renderer/services/chat/model";
import { ipcOk } from "../../../../../../src/shared/ipc/result";

interface IpcCall {
  method: string;
  args: Record<string, unknown>;
}

const calls: IpcCall[] = [];
let handle: (call: IpcCall) => unknown;
const realIpc = await import("../../../../../../src/renderer/ipc/client");
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: async (_channel: string, method: string, args: IpcCall["args"]) => {
    const call = { method, args };
    calls.push(call);
    return handle(call) ?? ipcOk(undefined);
  },
}));

const { ChatController } = await import(
  "../../../../../../src/renderer/services/chat/claude/controller"
);

let nextTab = 0;
const controllers: InstanceType<typeof ChatController>[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  calls.length = 0;
});

async function openSource() {
  const controller = new ChatController({
    workspaceId: "ws-history-change",
    tabId: `tab-${++nextTab}`,
    cwd: "/p",
    sessionId: "source",
  });
  controllers.push(controller);
  let seq = 0;
  const line = (dir: ChatLine["dir"], message: Record<string, unknown>) => {
    controller.receive({ seq: ++seq, dir, message });
  };
  handle = ({ method }) =>
    method === "replay" ? ipcOk({ found: true, running: true, lastSeq: 0 }) : undefined;
  await controller.open();
  return { controller, line };
}

test("Claude keeps source prompts recoverable if another conversation is selected after reconnect", async () => {
  const { controller, line } = await openSource();
  line("in", { type: "user", uuid: "first", message: { content: "Start the source turn" } });
  controller.flushNow();
  const queued = controller.enqueue("Send only to the source");

  handle = ({ method }) =>
    method === "replay" ? ipcOk({ found: false, running: false, lastSeq: 0 }) : undefined;
  controller.held();
  await controller.resync();
  expect(controller.state.phase).toBe("ended");

  await expect(controller.resumeSession("destination")).rejects.toThrow();
  expect(controller.currentSession()).toBe("source");
  expect(calls.map(({ method }) => method)).toEqual(["replay", "replay"]);
  expect(controller.removeQueued(queued as string)?.text).toBe("Send only to the source");
});

function prompt(harness: Awaited<ReturnType<typeof openSource>>, uuid: string, text: string) {
  const { controller, line } = harness;
  line("out", { type: "user", isReplay: true, uuid, message: { role: "user", content: text } });
  line("out", { type: "result", subtype: "success" });
  controller.flushNow();
  const item = controller.state.model.items.find(
    (item) => item.kind === "user" && item.uuid === uuid,
  );
  if (item?.kind !== "user") throw new Error("missing prompt");
  return item;
}

test("Claude rejects a stale rewind after the live conversation was cleared", async () => {
  const harness = await openSource();
  const { controller, line } = harness;
  const old = prompt(harness, "old", "Source prompt");
  line("out", { type: "conversation_reset" });
  line("out", { type: "system", subtype: "init", session_id: "destination" });
  const current = prompt(harness, "new", "Destination prompt");

  await expect(controller.rewind(old, { files: false })).rejects.toThrow();
  expect(controller.currentSession()).toBe("destination");
  expect(controller.state.model.items).toContain(current);
  expect(controller.state.draft).toBeUndefined();
  expect(calls.some(({ method }) => method === "stop" || method === "start")).toBe(false);
});
