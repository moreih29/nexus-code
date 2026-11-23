import { expect, spyOn, test } from "bun:test";
import * as React from "react";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { type ChatRef, usePeerChat } from "../../../../../src/renderer/services/remote/peer-chat";
import {
  PEER_CHAT_HANDOFF_MS,
  watchPeerChat,
} from "../../../../../src/renderer/services/remote/peer-chat-watch";
import * as room from "../../../../../src/renderer/services/remote/room";
import { ipcOk } from "../../../../../src/shared/ipc/result";

const chat = { deviceId: "desktop", workspaceId: "repo", tabId: "chat" };
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("switching views waits for the old chat watch to unwatch, including a late start", async () => {
  const first = Promise.withResolvers<ReturnType<typeof ipcOk<{ watchId: string }>>>();
  const unwatch = Promise.withResolvers<ReturnType<typeof ipcOk<undefined>>>();
  const calls = spyOn(ipc, "ipcCallResult")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => unwatch.promise)
    .mockResolvedValueOnce(ipcOk({ watchId: "workspace" }))
    .mockResolvedValueOnce(ipcOk(undefined));
  let stopAgent: (() => void) | undefined;
  let stopWorkspace: (() => void) | undefined;
  const results: string[] = [];
  try {
    stopAgent = watchPeerChat(chat, undefined, () => results.push("agent"));
    await settled();
    stopAgent();
    stopWorkspace = watchPeerChat(chat, undefined, () => results.push("workspace"));
    await settled();
    expect(calls.mock.calls.map(([, method]) => method)).toEqual(["peerChatWatch"]);
    first.resolve(ipcOk({ watchId: "agent" }));
    await settled();
    expect(calls.mock.calls.map(([, method]) => method)).toEqual([
      "peerChatWatch",
      "peerChatUnwatch",
    ]);
    expect(calls.mock.calls[1]?.[2]).toEqual({ deviceId: chat.deviceId, watchId: "agent" });
    expect(results).toEqual([]);
    unwatch.resolve(ipcOk(undefined));
    await settled();
    expect(calls.mock.calls.map(([, method]) => method)).toEqual([
      "peerChatWatch",
      "peerChatUnwatch",
      "peerChatWatch",
    ]);
    expect(results).toEqual(["workspace"]);
  } finally {
    first.resolve(ipcOk({ watchId: "agent" }));
    unwatch.resolve(ipcOk(undefined));
    stopAgent?.();
    stopWorkspace?.();
    await settled();
    calls.mockRestore();
  }
});

function mountChat(ref: ChatRef) {
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
    render(shown: boolean) {
      index = 0;
      apply = undefined;
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        // biome-ignore lint/correctness/useHookAtTopLevel: this harness supplies React's hook dispatcher
        usePeerChat(ref, shown);
      } finally {
        internals.H = previous;
      }
      const commit = apply as (() => void) | undefined;
      commit?.();
    },
    stop() {
      cleanup?.();
    },
  };
}

test("the chat hooks for Agents and the workspace hand off one live watch", async () => {
  const reply = {
    status: {
      agent: "claude",
      title: "Chat",
      running: false,
      process: "none",
      turn: null,
      streaming: null,
      permissions: [],
    },
    total: 0,
    start: 0,
    items: [],
    tools: {},
    tasks: {},
    agentItems: {},
  };
  const finishing = Promise.withResolvers<void>();
  const active = new Set<string>();
  let nextId = 0;
  const call = spyOn(ipc, "ipcCallResult").mockImplementation(async (_, method, args) => {
    if (method === "peerChatWatch") {
      expect(active.size).toBe(0);
      const watchId = String(++nextId);
      active.add(watchId);
      return ipcOk({ ...reply, watchId });
    }
    if (method === "peerChatUnwatch") {
      const { watchId } = args as { watchId: string };
      if (watchId === "1") await finishing.promise;
      active.delete(watchId);
    }
    return ipcOk(undefined);
  });
  const listen = spyOn(ipc, "ipcListen").mockReturnValue(() => {});
  const online = spyOn(room, "useRemoteRoom").mockReturnValue({
    status: "online",
    peers: [{ id: chat.deviceId, name: "Peer", platform: "linux", online: true }],
  });
  const agents = mountChat(chat);
  const workspace = mountChat(chat);
  try {
    agents.render(true);
    workspace.render(false);
    await settled();
    expect(active).toEqual(new Set(["1"]));
    agents.render(false);
    workspace.render(true);
    await settled();
    expect(active).toEqual(new Set(["1"]));
    expect(nextId).toBe(1);
    finishing.resolve();
    await settled();
    expect(active).toEqual(new Set(["2"]));
    workspace.render(false);
    agents.render(true);
    await settled();
    expect(active).toEqual(new Set(["3"]));
  } finally {
    finishing.resolve();
    agents.stop();
    workspace.stop();
    await settled();
    expect(active.size).toBe(0);
    online.mockRestore();
    listen.mockRestore();
    call.mockRestore();
  }
});

test("a stalled unwatch delays the replacement for at most the short handoff timeout", async () => {
  const unwatch = Promise.withResolvers<ReturnType<typeof ipcOk<undefined>>>();
  const calls = spyOn(ipc, "ipcCallResult")
    .mockResolvedValueOnce(ipcOk({ watchId: "old" }))
    .mockImplementationOnce(() => unwatch.promise)
    .mockResolvedValueOnce(ipcOk({ watchId: "new" }))
    .mockResolvedValueOnce(ipcOk(undefined));
  const realSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (delay === PEER_CHAT_HANDOFF_MS && typeof callback === "function") {
      expire = () => callback(...args);
      return realSetTimeout(() => {}, delay);
    }
    return realSetTimeout(callback, delay, ...args);
  });
  const stopOld = watchPeerChat(chat, undefined, () => {});
  let stopNext: (() => void) | undefined;
  try {
    await settled();
    stopOld();
    stopNext = watchPeerChat(chat, undefined, () => {});
    await settled();
    expect(calls.mock.calls.map(([, method]) => method)).toEqual([
      "peerChatWatch",
      "peerChatUnwatch",
    ]);
    expect(expire).toBeDefined();
    expire?.();
    await settled();
    expect(calls.mock.calls.map(([, method]) => method)).toEqual([
      "peerChatWatch",
      "peerChatUnwatch",
      "peerChatWatch",
    ]);
  } finally {
    stopOld();
    stopNext?.();
    unwatch.resolve(ipcOk(undefined));
    await settled();
    timers.mockRestore();
    calls.mockRestore();
  }
});
