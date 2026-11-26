import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as React from "react";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { usePeerTerminal } from "../../../../../src/renderer/services/remote/peer-terminal";
import {
  ALIVE_MS,
  type PeerWatched,
  type PeerWatchSession,
  REWATCH_MS,
  usePeerWatch,
} from "../../../../../src/renderer/services/remote/peer-watch";
import * as room from "../../../../../src/renderer/services/remote/room";
import { ipcOk } from "../../../../../src/shared/ipc/result";
import type { RoomState } from "../../../../../src/shared/remote/room";

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(hook: () => void) {
  const values: unknown[] = [];
  let index = 0;
  let lastDeps: React.DependencyList | undefined;
  let cleanup: ReturnType<React.EffectCallback>;
  let apply: (() => void) | undefined;
  const dispatcher = {
    useState(initial: unknown) {
      const slot = index++;
      if (!(slot in values)) values[slot] = initial;
      return [
        values[slot],
        (next: unknown) => {
          values[slot] = typeof next === "function" ? next(values[slot]) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const slot = index++;
      values[slot] ??= { current: initial };
      return values[slot];
    },
    useCallback: (callback: unknown) => callback,
    useEffect(effect: React.EffectCallback, deps: React.DependencyList) {
      if (lastDeps && deps.every((next, i) => Object.is(next, lastDeps?.[i]))) return;
      apply = () => {
        cleanup?.();
        lastDeps = deps;
        cleanup = effect();
      };
    },
  };
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: typeof dispatcher | null;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return {
    render() {
      index = 0;
      apply = undefined;
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        hook();
      } finally {
        internals.H = previous;
      }
      const commit = apply as (() => void) | undefined;
      commit?.();
    },
    unmount() {
      cleanup?.();
      cleanup = undefined;
    },
  };
}

const deviceId = "desktop";
let peerRoom: RoomState;
let updates: ((event: { deviceId: string; update: unknown }) => void) | undefined;
let timeouts: { delay: number | undefined; run: () => void }[];
let intervals: { delay: number | undefined; run: () => void }[];
const restore: (() => void)[] = [];

beforeEach(() => {
  peerRoom = {
    status: "online",
    peers: [{ id: deviceId, name: "Peer", platform: "linux", online: true, rejoins: 0 }],
  };
  updates = undefined;
  timeouts = [];
  intervals = [];
  const roomSpy = spyOn(room, "useRemoteRoom").mockImplementation(() => peerRoom);
  const listen = spyOn(ipc, "ipcListen").mockImplementation(((
    _channel: string,
    _event: string,
    callback: typeof updates,
  ) => {
    updates = callback;
    return () => {
      updates = undefined;
    };
  }) as unknown as typeof ipc.ipcListen);
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    if (delay === REWATCH_MS) {
      timeouts.push({ delay, run });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realTimeout(run, delay);
  }) as typeof setTimeout;
  globalThis.setInterval = ((run: () => void, delay?: number) => {
    intervals.push({ delay, run });
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  restore.push(
    () => roomSpy.mockRestore(),
    () => listen.mockRestore(),
    () => {
      globalThis.setTimeout = realTimeout;
      globalThis.setInterval = realInterval;
    },
  );
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

function watcher() {
  const sessions: PeerWatchSession<PeerWatched>[] = [];
  const seen: unknown[] = [];
  const probed: PeerWatched[] = [];
  let state: ReturnType<typeof usePeerWatch> | undefined;
  let stops = 0;
  const view = mount(() => {
    state = usePeerWatch<PeerWatched, "peerChatUpdate">({
      deviceId,
      target: "tab",
      shown: true,
      updates: "peerChatUpdate",
      start(session) {
        sessions.push(session);
        return {
          update: (update) => seen.push(update),
          probe: (watch) => probed.push(watch),
          stop: () => {
            stops++;
          },
        };
      },
    });
  });
  return { view, sessions, seen, probed, stops: () => stops, state: () => state };
}

test("a skipped chat revision makes the watch unready while the peer stays online", () => {
  const { view, sessions, state } = watcher();
  view.render();
  expect(state()).toEqual({ online: true, ready: false });
  sessions[0]?.opened({ id: "first", rev: 0 });
  view.render();
  expect(state()).toEqual({ online: true, ready: true });

  updates?.({ deviceId, update: { watchId: "first", rev: 2 } });
  view.render();
  expect(state()).toEqual({ online: true, ready: false });
  sessions[0]?.opened({ id: "late", rev: 0 });
  view.render();
  expect(state()).toEqual({ online: true, ready: false });

  sessions[1]?.opened({ id: "current", rev: 0 });
  view.render();
  expect(state()).toEqual({ online: true, ready: true });
  view.unmount();
});

test("a reconnect or a skipped revision starts the watch again", () => {
  const { view, sessions, seen, stops } = watcher();
  view.render();
  expect(sessions.length).toBe(1);
  sessions[0]?.opened({ id: "w1", rev: 0 });
  updates?.({ deviceId, update: { watchId: "w1", rev: 1 } });
  expect(seen).toEqual([{ watchId: "w1", rev: 1 }]);

  peerRoom = {
    ...peerRoom,
    peers: [{ id: deviceId, name: "Peer", platform: "linux", online: true, rejoins: 1 }],
  };
  view.render();
  expect(stops()).toBe(1);
  expect(sessions.length).toBe(2);
  expect(sessions[0]?.live()).toBe(false);
  expect(sessions[1]?.current()).toBeNull();

  sessions[1]?.opened({ id: "w2", rev: 0 });
  updates?.({ deviceId, update: { watchId: "w2", rev: 2 } });
  view.render();
  expect(stops()).toBe(2);
  expect(sessions.length).toBe(3);
  expect(seen.length).toBe(1);
  view.unmount();
});

test("a watch that gets no answer is tried again, and the open watch is probed", () => {
  const { view, sessions, probed } = watcher();
  view.render();
  sessions[0]?.retry();
  expect(timeouts.map(({ delay }) => delay)).toEqual([REWATCH_MS]);
  timeouts[0]?.run();
  view.render();
  expect(sessions.length).toBe(2);

  const alive = intervals.at(-1);
  expect(alive?.delay).toBe(ALIVE_MS);
  alive?.run();
  expect(probed).toEqual([]);
  sessions[1]?.opened({ id: "w", rev: 0 });
  alive?.run();
  expect(probed).toEqual([{ id: "w", rev: 0 }]);
  view.unmount();
});

test("a peer terminal unwatches exactly once on unmount, even when the watch answers late", async () => {
  const late = Promise.withResolvers<unknown>();
  const calls = spyOn(ipc, "ipcCallResult").mockImplementation((async (
    _channel: string,
    method: string,
    args: { tabId?: string },
  ) => {
    if (method === "peerTerminalWatch") {
      if (args.tabId === "late") return late.promise;
      return ipcOk({ watchId: `watch-${args.tabId}`, text: "" });
    }
    return ipcOk(undefined);
  }) as unknown as typeof ipc.ipcCallResult);
  try {
    const open = mount(() => {
      usePeerTerminal({ deviceId, workspaceId: "repo", tabId: "open" }, 10, true);
    });
    open.render();
    await settled();
    open.unmount();
    await settled();

    const slow = mount(() => {
      usePeerTerminal({ deviceId, workspaceId: "repo", tabId: "late" }, 10, true);
    });
    slow.render();
    await settled();
    slow.unmount();
    late.resolve(ipcOk({ watchId: "watch-late", text: "" }));
    await settled();
    await settled();

    const unwatched = calls.mock.calls
      .filter(([, method]) => method === "peerTerminalUnwatch")
      .map(([, , args]) => args);
    expect(unwatched).toEqual([
      { deviceId, watchId: "watch-open" },
      { deviceId, watchId: "watch-late" },
    ]);
  } finally {
    late.resolve(ipcOk({ watchId: "watch-late", text: "" }));
    calls.mockRestore();
  }
});
