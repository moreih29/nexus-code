import { describe, expect, test } from "bun:test";
import type { RoomPeer, RoomState } from "../../../../../src/shared/remote/room";

const { DROP_SHOWN_AFTER_MS, noteDrops, shownRoom } = await import(
  "../../../../../src/renderer/services/remote/room"
);

const peer = (id: string, online: boolean): RoomPeer => ({
  id,
  name: id,
  platform: "darwin",
  online,
  serves: ["sessions"],
});
const room = (status: RoomState["status"], ...peers: RoomPeer[]): RoomState => ({ status, peers });

function shownAfter(steps: [number, RoomState][], at: number, deviceId?: string) {
  const drops = new Map<string, number>();
  let prev: RoomState | null = null;
  for (const [time, next] of steps) {
    noteDrops(prev, next, drops, time);
    prev = next;
  }
  return shownRoom(prev, drops, at, deviceId);
}

describe("the room as the screen shows it", () => {
  const online = room("online", peer("a", true), peer("b", false));

  test("this device back within three seconds: never seen out, nor the others", () => {
    const steps: [number, RoomState][] = [
      [0, online],
      [1000, room("connecting", peer("a", false), peer("b", false))],
    ];
    const shown = shownAfter(steps, 2000);
    expect(shown.room?.status).toBe("online");
    expect(shown.room?.peers.map((p) => p.online)).toEqual([true, false]);
    expect(shown.until).toBe(1000 + DROP_SHOWN_AFTER_MS);
  });

  test("out longer: shown as it is", () => {
    const steps: [number, RoomState][] = [
      [0, online],
      [1000, room("waiting", peer("a", false), peer("b", false))],
    ];
    const shown = shownAfter(steps, 1000 + DROP_SHOWN_AFTER_MS);
    expect(shown.room?.status).toBe("waiting");
    expect(shown.until).toBeUndefined();
  });

  test("the time counts from the drop, not from each change while out", () => {
    const steps: [number, RoomState][] = [
      [0, online],
      [1000, room("connecting", peer("a", false))],
      [2500, room("waiting", peer("a", false))],
    ];
    expect(shownAfter(steps, 4100).room?.status).toBe("waiting");
  });

  test("another device that dropped shows online for three seconds, then offline", () => {
    const steps: [number, RoomState][] = [
      [0, online],
      [500, room("online", peer("a", false), peer("b", false))],
    ];
    expect(shownAfter(steps, 1000).room?.peers[0]?.online).toBe(true);
    expect(shownAfter(steps, 500 + DROP_SHOWN_AFTER_MS).room?.peers[0]?.online).toBe(false);
  });

  test("a chat uses its own peer's deadline when two devices drop at different times", () => {
    const steps: [number, RoomState][] = [
      [0, room("online", peer("a", true), peer("b", true))],
      [500, room("online", peer("a", false), peer("b", true))],
      [1000, room("online", peer("a", false), peer("b", false))],
      [2000, room("online", peer("a", false), peer("b", true))],
    ];
    expect(shownAfter(steps.slice(0, 3), 1100, "b").until).toBe(1000 + DROP_SHOWN_AFTER_MS);
    expect(shownAfter(steps, 2100, "b").until).toBeUndefined();
  });

  test("signed out, replaced or outdated shows at once", () => {
    for (const status of ["off", "replaced", "outdated", "stopped"] as const) {
      const shown = shownAfter(
        [
          [0, online],
          [1000, room(status)],
        ],
        1100,
      );
      expect(shown.room?.status).toBe(status);
    }
  });

  test("one never seen online is not shown so", () => {
    const shown = shownAfter([[0, room("connecting", peer("a", false))]], 10);
    expect(shown.room?.status).toBe("connecting");
  });
});
