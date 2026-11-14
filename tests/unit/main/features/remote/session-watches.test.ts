import { afterEach, describe, expect, test } from "bun:test";
import type { RpcResult, SessionsUpdate } from "../../../../../packages/remote-protocol/src";
import { RpcFailure } from "../../../../../src/main/features/remote/room";
import {
  MAX_SESSION_WATCHES_PER_DEVICE,
  SessionWatches,
} from "../../../../../src/main/features/remote/session-watches";

type List = RpcResult<"sessions.list">;

const listOf = (title: string): List => ({
  workspaces: [{ id: "w1", name: "app", path: "/app" }],
  sessions: [{ workspaceId: "w1", tabId: "t1", kind: "claude", title, state: "idle" }],
});

let made: SessionWatches[] = [];
afterEach(() => {
  for (const w of made) w.dropAll();
  made = [];
});

function setup() {
  let now = listOf("first");
  const sent: { to: string; update: SessionsUpdate }[] = [];
  const watches = new SessionWatches({
    list: async () => now,
    notify: async (to, update) => {
      sent.push({ to, update });
      return true;
    },
    // Polled by the test, not the clock.
    pollMs: 60_000,
  });
  made.push(watches);
  return {
    watches,
    sent,
    set(next: List) {
      now = next;
    },
  };
}

describe("watching the sessions' list", () => {
  test("each device is sent the consent prompts as it may answer them; time running out is no change", async () => {
    let left = 60_000;
    let answerable = true;
    const sent: { to: string; update: SessionsUpdate }[] = [];
    const consent = (to: string) => ({
      id: "c1",
      at: 0,
      expiresAt: 60_000,
      expiresInMs: left,
      from: { workspaceId: "w1", tabId: "t1" },
      workspaceId: "w2",
      change: { kind: "chatInput" },
      eachTime: false,
      answerable: answerable && to === "phone",
    });
    const watches = new SessionWatches({
      list: async () => listOf("first"),
      consents: async (to) => [consent(to)],
      notify: async (to, update) => {
        sent.push({ to, update });
        return true;
      },
      pollMs: 60_000,
    });
    made.push(watches);
    const phone = await watches.watch("phone");
    const mac = await watches.watch("mac");
    expect(phone.consents?.[0]?.answerable).toBe(true);
    expect(mac.consents?.[0]?.answerable).toBe(false);
    left = 30_000;
    await watches.poll();
    expect(sent).toHaveLength(0);
    // The user turned the chats' controls off: the phone may no longer answer.
    answerable = false;
    await watches.poll();
    expect(sent.map((s) => s.to)).toEqual(["phone"]);
    expect(sent[0]?.update.consents?.[0]).toMatchObject({ answerable: false, expiresInMs: 30_000 });
  });

  test("starts with the list, then sends it only when it changed", async () => {
    const { watches, sent, set } = setup();
    const first = await watches.watch("phone");
    expect(first.sessions[0]?.title).toBe("first");
    await watches.poll();
    expect(sent).toHaveLength(0);
    set(listOf("second"));
    await watches.poll();
    await watches.poll();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("phone");
    expect(sent[0]?.update.watchId).toBe(first.watchId);
    expect(sent[0]?.update.sessions[0]?.title).toBe("second");
  });

  test("each watcher is sent what it has not seen", async () => {
    const { watches, sent, set } = setup();
    await watches.watch("phone");
    set(listOf("second"));
    // The laptop starts on the second list: it has nothing new to be sent.
    await watches.watch("laptop");
    await watches.poll();
    expect(sent.map((s) => s.to)).toEqual(["phone"]);
  });

  test("an unwatch is the watcher's own; a device that left ends its watches", async () => {
    const { watches, sent, set } = setup();
    const { watchId } = await watches.watch("phone");
    expect(() => watches.unwatch("laptop", { watchId })).toThrow(RpcFailure);
    await watches.watch("laptop");
    watches.dropDevice("laptop");
    expect(watches.watchers()).toEqual(["phone"]);
    watches.unwatch("phone", { watchId });
    expect(watches.watchers()).toEqual([]);
    set(listOf("second"));
    await watches.poll();
    expect(sent).toHaveLength(0);
  });

  test("a device watching too many lists ends its oldest", async () => {
    const { watches, sent, set } = setup();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_SESSION_WATCHES_PER_DEVICE; i++) {
      ids.push((await watches.watch("phone")).watchId);
    }
    set(listOf("second"));
    await watches.poll();
    expect(sent.map((s) => s.update.watchId)).toEqual(ids.slice(1));
  });
});
