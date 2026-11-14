/**
 * Another device reading a Claude chat not open here sees its conversation
 * once the transcript is read, without waiting for the program started on
 * it to be ready. The real ipc client is spread under a spy, so later
 * files keep its other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

let releaseStart: () => void = () => {};
let started = false;

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (_channel: string, method: string) => {
    if (method === "replay") {
      return Promise.resolve({ ok: true, value: { found: false } });
    }
    if (method === "transcript") {
      return Promise.resolve({
        ok: true,
        value: {
          found: true,
          lines: [
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-11-13T10:00:00.000Z",
              message: { role: "user", content: "Reply with just ok" },
            },
          ],
        },
      });
    }
    if (method === "start") {
      // The program takes its time: answered only when the test says.
      return new Promise((resolve) => {
        releaseStart = () => {
          started = true;
          resolve({ ok: true, value: { ok: true, version: "2.1.322", attached: false } });
        };
      });
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import("../../../../../src/renderer/services/chat/controller");
const { useChatStore, chatKey } = await import("../../../../../src/renderer/services/chat/store");
type Controller = InstanceType<typeof ChatController>;

const live: Controller[] = [];

afterEach(() => {
  releaseStart();
  for (const c of live.splice(0)) c.dispose();
  started = false;
});

describe("opening a Claude tab to read it", () => {
  test("comes back with the transcript shown while the program is still starting", async () => {
    const c = new ChatController({
      workspaceId: "ws-read",
      tabId: "t-read",
      cwd: "/p",
      sessionId: "s-read",
    });
    live.push(c);
    const opening = c.open();
    await c.openToRead();
    expect(started).toBe(false);
    const state = useChatStore.getState().tabs[chatKey("ws-read", "t-read")];
    expect(state?.history?.items.some((item) => item.kind === "user")).toBe(true);
    expect(state?.phase).toBe("starting");
    releaseStart();
    await opening;
    expect(started).toBe(true);
  });

  test("a new tab, with no session to read, comes back at once", async () => {
    const c = new ChatController({ workspaceId: "ws-read", tabId: "t-new", cwd: "/p" });
    live.push(c);
    await c.openToRead();
    expect(started).toBe(false);
    expect(useChatStore.getState().tabs[chatKey("ws-read", "t-new")]?.history ?? null).toBeNull();
  });
});
