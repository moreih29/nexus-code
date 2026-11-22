import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import {
  peerTarget,
  usePeerWorkbench,
} from "../../../../../src/renderer/components/peer-workspace/room";
import * as accounts from "../../../../../src/renderer/services/remote/account";
import * as git from "../../../../../src/renderer/services/remote/peer-git-status";
import * as rooms from "../../../../../src/renderer/services/remote/room";
import {
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../../../../src/renderer/state/stores/peer-workspace";
import type { RoomState } from "../../../../../src/shared/remote/room";

function workbenchEffects() {
  const effects: { deps: React.DependencyList; cleanup: ReturnType<React.EffectCallback> }[] = [];
  let index = 0;
  const ref = { current: null };
  const pending: (() => void)[] = [];
  const dispatcher = {
    useRef: () => ref,
    useState: (initial: unknown) => [initial, () => {}],
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useDebugValue: () => {},
    useEffect(effect: React.EffectCallback, deps: React.DependencyList) {
      const slot = index++;
      const before = effects[slot];
      if (
        before &&
        deps.length === before.deps.length &&
        deps.every((value, i) => Object.is(value, before.deps[i]))
      )
        return;
      pending.push(() => {
        before?.cleanup?.();
        effects[slot] = { deps, cleanup: effect() };
      });
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
    render(workspaceShown: boolean) {
      index = 0;
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        // biome-ignore lint/correctness/useHookAtTopLevel: the test dispatcher mounts the hook here
        usePeerWorkbench(false, workspaceShown);
      } finally {
        internals.H = previous;
      }
      for (const effect of pending.splice(0)) effect();
    },
    stop() {
      for (const effect of effects) effect.cleanup?.();
    },
  };
}

test("the workbench stops peer Git while offline, in Agents or missing, and restarts on rejoin", () => {
  const signedIn = {
    status: "signed-in" as const,
    server: "https://test.example",
    user: { id: "user", name: "User", email: "user@test.example" },
    device: { id: "self", name: "Here", platform: "linux" },
  };
  const computer = {
    id: "peer",
    name: "Other",
    platform: "linux",
    online: true,
    serves: ["git"],
    rejoins: 0,
  };
  const connection = (online: boolean, rejoins: number): RoomState => ({
    status: "online",
    peers: [{ ...computer, online, rejoins }],
  });
  const previous = usePeerWorkspaceStore.getState();
  const view = peerTarget(accounts.remoteAccountKey(signedIn)!, computer, {
    id: "work",
    name: "Work",
    path: "/work",
  });
  const store = usePeerWorkspaceStore.getState();
  const stops: ReturnType<typeof mock>[] = [];
  const unobserve = mock(() => {});
  const account = spyOn(accounts, "useRemoteAccount").mockReturnValue(signedIn);
  const room = spyOn(rooms, "useRemoteRoom").mockReturnValue(connection(true, 0));
  const shown = spyOn(rooms, "useShownRoom").mockImplementation((state) => state);
  const lists = spyOn(rooms, "usePeerSessions").mockReturnValue({});
  const observe = spyOn(rooms, "observePeerSessions").mockReturnValue(unobserve);
  const watch = spyOn(git, "watchPeerGitStatus").mockImplementation(() => {
    const stop = mock(() => {});
    stops.push(stop);
    return { refresh: () => {}, updateSessions: () => {}, stop };
  });
  const harness = workbenchEffects();
  try {
    store.select(view, null);
    harness.render(true);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.slice(0, 2)).toEqual(["peer", 0]);

    room.mockReturnValue(connection(false, 0));
    harness.render(true);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(unobserve).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(1);

    room.mockReturnValue(connection(true, 1));
    harness.render(true);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls[1]?.slice(0, 2)).toEqual(["peer", 1]);

    harness.render(false);
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(2);
    harness.render(true);
    expect(watch).toHaveBeenCalledTimes(3);

    store.markMissing(peerTargetId(view));
    harness.render(true);
    expect(stops[2]).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(3);

    store.select(view, null);
    harness.render(true);
    room.mockReturnValue(connection(true, 2));
    harness.render(true);
    expect(stops[3]).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls.at(-1)?.slice(0, 2)).toEqual(["peer", 2]);
    expect(watch).toHaveBeenCalledTimes(5);
  } finally {
    harness.stop();
    watch.mockRestore();
    observe.mockRestore();
    lists.mockRestore();
    shown.mockRestore();
    room.mockRestore();
    account.mockRestore();
    usePeerWorkspaceStore.setState(previous, true);
  }
});
