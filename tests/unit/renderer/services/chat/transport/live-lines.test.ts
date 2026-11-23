import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  ChatController,
  chatController,
} from "../../../../../../src/renderer/services/chat/claude/controller";
import { codexController } from "../../../../../../src/renderer/services/chat/codex/controller";
import type { ChatLine } from "../../../../../../src/renderer/services/chat/model";
import { useChatStore } from "../../../../../../src/renderer/services/chat/store";
import { LiveLines } from "../../../../../../src/renderer/services/chat/transport/live-lines";

const line = (seq: number, replay = false): ChatLine => ({
  seq,
  dir: "out",
  message: { type: "system", subtype: "hook_started" },
  ...(replay ? { replay: true } : {}),
});

describe("LiveLines", () => {
  test("lets lines by when not held", () => {
    const live = new LiveLines();
    expect(live.holds(line(1))).toBe(false);
    expect(live.release()).toEqual([]);
  });

  test("holds new lines, never the log's, until released", () => {
    const live = new LiveLines();
    live.hold();
    expect(live.holds(line(5))).toBe(true);
    expect(live.holds(line(3, true))).toBe(false);
    expect(live.holds(line(6))).toBe(true);
    expect(live.release().map((l) => l.seq)).toEqual([5, 6]);
    expect(live.holds(line(7))).toBe(false);
  });

  test("a hold within a hold lets them go at the last release", () => {
    const live = new LiveLines();
    live.hold();
    live.hold();
    live.holds(line(5));
    expect(live.release()).toEqual([]);
    expect(live.release().map((l) => l.seq)).toEqual([5]);
  });
});

const W = globalThis as { window?: unknown };
const before = W.window;
afterEach(() => {
  W.window = before;
});

describe("a Claude tab's replay", () => {
  test("a new line before the log's keeps the program the log starts", async () => {
    const c = new ChatController({ workspaceId: "ws-live", tabId: "t-live", cwd: "/p" });
    const start: ChatLine = { seq: 13, dir: "sys", message: { event: "start", pid: 1 } };
    W.window = {
      ipc: {
        call: async (_channel: string, method: string) => {
          if (method !== "replay") throw new Error(`unexpected ${method}`);
          c.receive(line(14));
          setTimeout(() => {
            c.receive({ ...start, replay: true });
            c.receive(line(14, true));
          }, 5);
          return { found: true, running: true, truncated: false, lastSeq: 14 };
        },
      },
    };
    await c.resync();
    expect(c.state.model.process).toBe("running");
    expect(c.state.model.lastSeq).toBe(14);
    c.receive(line(15));
    c.flushNow();
    expect(c.state.model.lastSeq).toBe(15);
    c.dispose();
  });
});

const routingCase = "routes both providers with one IPC subscription and unregisters closed tabs";

test(routingCase, async () => {
  if (process.env.NEXUS_CHAT_ROUTING_FIXTURE !== "1") {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", routingCase], {
      env: { ...process.env, NEXUS_CHAT_ROUTING_FIXTURE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(stdout + stderr);
    return;
  }

  const subscriptions: string[] = [];
  const callbacks = new Map<string, (payload: unknown) => void>();
  const replays: unknown[] = [];
  W.window = {
    ipc: {
      listen: (channel: string, event: string, callback: (payload: unknown) => void) => {
        subscriptions.push(`${channel}.${event}`);
        callbacks.set(event, callback);
        return () => callbacks.delete(event);
      },
      call: async (channel: string, method: string, args: unknown) => {
        if (channel !== "chat" || method !== "replay")
          throw new Error(`unexpected ${channel}.${method}`);
        replays.push(args);
        return { found: true, running: true, truncated: false, lastSeq: 1 };
      },
    },
  };
  const first = { workspaceId: "claude-workspace", tabId: "same-tab" };
  const second = { workspaceId: "codex-workspace", tabId: "same-tab" };
  const claude = chatController({ ...first, cwd: "/claude" });
  const codex = codexController({ ...second, cwd: "/codex" });
  const receiveClaude = spyOn(claude, "receive");
  const receiveCodex = spyOn(codex, "receive");
  const emit = (event: string, payload: unknown) => {
    const callback = callbacks.get(event);
    if (!callback) throw new Error(`missing subscription for ${event}`);
    callback(payload);
  };
  try {
    expect(subscriptions).toEqual(["chat.line", "chat.held", "chat.resync"]);
    const start = { seq: 1, dir: "sys", message: { event: "start" } };
    emit("line", { ...first, ...start });
    emit("line", { ...second, ...start });
    expect(receiveClaude).toHaveBeenCalledTimes(1);
    expect(receiveCodex).toHaveBeenCalledTimes(1);
    expect(receiveClaude.mock.calls[0]?.[0]).toMatchObject(first);
    expect(receiveCodex.mock.calls[0]?.[0]).toMatchObject(second);
    claude.flushNow();
    codex.flushNow();
    for (const controller of [claude, codex]) {
      useChatStore.getState().update(controller.key, (state) => ({ ...state, phase: "ready" }));
    }

    emit("held", { workspaceId: first.workspaceId });
    expect(claude.state.phase).toBe("held");
    expect(codex.state.phase).toBe("ready");
    emit("resync", { workspaceId: first.workspaceId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replays).toEqual([{ ...first, afterSeq: 1 }]);
    expect(claude.state.phase).toBe("ready");

    claude.dispose();
    codex.dispose();
    emit("line", { ...first, ...line(2) });
    emit("line", { ...second, ...line(2) });
    expect(receiveClaude).toHaveBeenCalledTimes(1);
    expect(receiveCodex).toHaveBeenCalledTimes(1);
  } finally {
    claude.dispose();
    codex.dispose();
  }
});
