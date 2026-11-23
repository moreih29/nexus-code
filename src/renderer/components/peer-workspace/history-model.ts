import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import { type IpcResult, ipcErr } from "../../../shared/ipc/result";
import { createListenerBus } from "../../../shared/util/listener-bus";
import { ipcCallResult } from "../../ipc/client";

export type PeerHistoryCommit = RpcResult<"git.log">["commits"][number];

const PAGE_SIZE = 50;

interface HistorySnapshot {
  readonly commits: readonly PeerHistoryCommit[] | null;
  readonly nextSkip: number | null;
  readonly pending: boolean;
  readonly error?: string;
}

export function createPeerHistory({ deviceId, workspaceId }: PeerWorkspace) {
  const listeners = createListenerBus();
  let state: HistorySnapshot = { commits: null, nextSkip: null, pending: false };
  let connection: number | undefined;
  let loadedOn: number | undefined;
  let flight: AbortController | undefined;

  function set(next: HistorySnapshot) {
    state = next;
    listeners.notify();
  }

  async function load(skip: number) {
    const active = connection;
    if (active === undefined) return;
    flight?.abort();
    const controller = new AbortController();
    const { signal } = controller;
    flight = controller;
    set({ ...state, pending: true, error: undefined });

    let result: IpcResult<RpcResult<"git.log">>;
    try {
      result = await ipcCallResult(
        "remote",
        "peerGitLog",
        { deviceId, workspaceId, limit: PAGE_SIZE, skip },
        { signal },
      );
    } catch {
      result = ipcErr("unavailable", "");
    }
    if (signal.aborted) return;
    flight = undefined;
    loadedOn = active;
    if (!result.ok) {
      if (result.kind === "not-found") {
        set({ commits: null, nextSkip: null, pending: false, error: result.kind });
      } else {
        set({ ...state, pending: false, error: result.kind });
      }
      return;
    }

    const page = result.value.commits;
    const entries = new Map<string, PeerHistoryCommit>();
    if (skip > 0) {
      for (const commit of state.commits ?? []) entries.set(commit.hash, commit);
    }
    for (const commit of page) entries.set(commit.hash, commit);
    set({
      commits: [...entries.values()],
      nextSkip: page.length >= PAGE_SIZE ? skip + page.length : null,
      pending: false,
    });
  }

  return {
    subscribe: listeners.subscribe,
    getSnapshot: () => state,
    resume(rejoin: number) {
      connection = rejoin;
      if (loadedOn !== rejoin && !flight) return load(0);
    },
    pause() {
      connection = undefined;
      flight?.abort();
      flight = undefined;
      if (state.pending) set({ ...state, pending: false });
    },
    refresh: () => load(0),
    more() {
      if (!state.pending && state.nextSkip !== null) return load(state.nextSkip);
    },
  };
}
