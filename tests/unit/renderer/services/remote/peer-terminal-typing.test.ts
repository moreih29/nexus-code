import { expect, test } from "bun:test";
import { watchPeerTerminalTyping } from "../../../../../src/renderer/services/remote/peer-terminal";
import type { TerminalTyping } from "../../../../../src/renderer/services/remote/terminal-typing";
import type { RoomState } from "../../../../../src/shared/remote/room";

/** Describes one allowed peer without hiding brief connection changes. */
function room(rejoins: number, status: RoomState["status"] = "online"): RoomState {
  return {
    status,
    peers: [
      {
        id: "peer",
        name: "PC",
        platform: "darwin",
        online: true,
        serves: ["terminal.control"],
        rejoins,
      },
    ],
  };
}

/** Lets the IPC promise and queue drain's continuation settle after a reply. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

test("a rejoin or disconnection closes the old queue before another send can drain it", async () => {
  const snapshot = Promise.withResolvers<RoomState>();
  const sent: Array<{ text: string; reply: ReturnType<typeof Promise.withResolvers<object>> }> = [];
  const errors: unknown[] = [];
  const controllers: Array<TerminalTyping | null> = [];
  let emitRoom: ((next: RoomState) => void) | undefined;
  const originalWindow = globalThis.window;
  Object.assign(globalThis, {
    window: {
      ipc: {
        listen: (_channel: string, event: string, callback: typeof emitRoom) => {
          if (event === "roomChanged") emitRoom = callback;
          return () => {
            emitRoom = undefined;
          };
        },
        call: (_channel: string, method: string, args: { text: string }) => {
          if (method === "room") return snapshot.promise;
          if (method !== "peerTerminalInput") throw new Error(`Unexpected call ${method}`);
          const reply = Promise.withResolvers<object>();
          sent.push({ text: args.text, reply });
          return reply.promise;
        },
      },
    },
  });
  const stop = watchPeerTerminalTyping(
    { deviceId: "peer", workspaceId: "ws", tabId: "tab" },
    (typing) => controllers.push(typing),
    (error) => errors.push(error),
  );
  try {
    if (!emitRoom) throw new Error("missing room subscription");
    emitRoom(room(0));
    const beforeRejoin = controllers.at(-1);
    beforeRejoin?.type({ text: "already sent" });
    beforeRejoin?.type({ text: "queued before peer rejoin" });

    emitRoom(room(1));
    beforeRejoin?.type({ text: "stale input box" });
    snapshot.resolve(room(0));
    sent[0]?.reply.resolve({});
    await settle();
    expect(sent.map(({ text }) => text)).toEqual(["already sent"]);
    expect(controllers).toHaveLength(2);

    const beforeDrop = controllers.at(-1);
    beforeDrop?.type({ text: "after rejoin" });
    beforeDrop?.type({ text: "queued before relay drop" });
    emitRoom(room(1, "waiting"));
    expect(controllers.at(-1)).toBeNull();
    emitRoom(room(1));
    const current = controllers.at(-1);
    current?.type({ text: "first on new connection" });
    current?.type({ text: "second on new connection" });

    sent[1]?.reply.reject(new Error("late failure from old connection"));
    await settle();
    expect(sent.map(({ text }) => text)).toEqual([
      "already sent",
      "after rejoin",
      "first on new connection",
    ]);
    expect(errors).toHaveLength(2); // One loss notice for each retired queue.
    sent[2]?.reply.resolve({});
    await settle();
    expect(sent.at(-1)?.text).toBe("second on new connection");

    current?.type({ text: "queued before the pane closes" });
    stop();
    sent[3]?.reply.resolve({});
    await settle();
    expect(sent).toHaveLength(4);
  } finally {
    stop();
    for (const { reply } of sent) reply.resolve({});
    await settle();
    Object.assign(globalThis, { window: originalWindow });
  }
});
